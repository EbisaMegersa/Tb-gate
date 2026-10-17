// ============================================================
// wallet-bot v2 — Telebirr Edition (official receipt verification)
// Birr (ETB) only · simplified commands · zero dependencies
//
// Deposit verification logic is ported from the open-source
// telebirr-receipt library (github.com/TheRealYT/telebirr-receipt,
// Apache-2.0) and adapted for Cloudflare Workers:
// the bot fetches the OFFICIAL receipt page
// https://transactioninfo.ethiotelecom.et/receipt/{receiptNo}
// and only credits when the check passes.
//
// REQUIRED CLOUDFLARE SETTINGS (same as before):
//   KV namespace binding : WALLET
//   Secrets              : BOT_TOKEN, ADMIN_ID
//   Optional variables   : TELEBIRR_NUMBER, TELEBIRR_NAME, MIN_DEPOSIT
//   (or just edit CONFIG below — then commit, auto-deploy)
// ============================================================

const CONFIG = {
  TELEBIRR_NUMBER: "0931454841", // your Telebirr number users pay to
  TELEBIRR_NAME: "Magarsa",    // EXACTLY as shown on your Telebirr account (appears as "credited party" on receipts)
  MIN_DEPOSIT: "1",             // minimum deposit in ETB
};

const RECEIPT_SITE = "https://transactioninfo.ethiotelecom.et/receipt/";

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("✅ Wallet bot is running");
    }

    const update = await request.json();
    const msg = update.message;
    if (!msg) return new Response("OK");

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const name = msg.from.first_name || "User";
    const T = env.BOT_TOKEN;
    const isAdmin = userId === String(env.ADMIN_ID);
    const cfg = (k) => env[k] || CONFIG[k];
    const text = (msg.text || "").trim();
    const who = { chatId, userId, name };

    if (text === "/start") {
      if ((await env.WALLET.get("bal:" + userId)) === null) {
        await env.WALLET.put("bal:" + userId, "0");
      }
      await send(T, chatId,
        "👋 Welcome, " + name + "!\n\n" +
        "💵 Deposit — pay via Telebirr, credited automatically\n" +
        "💰 Balance — check your wallet\n\n" +
        "All amounts are in Ethiopian Birr (ETB).", menu());
    }

    else if (text === "💵 Deposit" || text === "/deposit") {
      await send(T, chatId,
        "💵 How to deposit:\n\n" +
        "1️⃣ Pay any amount to Telebirr number:\n" +
        cfg("TELEBIRR_NUMBER") + "\n\n" +
        "2️⃣ Open the confirmation SMS from Telebirr (127)\n\n" +
        "3️⃣ Send the receipt number here — or paste the whole receipt link from the SMS\n\n" +
        "✅ Verified against the official Telebirr page and credited automatically.\n" +
        "Minimum: " + cfg("MIN_DEPOSIT") + " ETB\n\n" +
        "⚠️ Every receipt number works only once.");
    }

    else if (text === "💰 Balance" || text === "/balance") {
      const bal = await env.WALLET.get("bal:" + userId) || "0";
      await send(T, chatId, "💼 Your balance: " + fmt(bal) + " ETB");
    }

    else if (text.startsWith("/address")) {
      const raw = (text.split(/\s+/)[1] || "").replace(/[\s\-()]/g, "");
      if (!/^(?:\+?251|0)?9\d{8}$/.test(raw)) {
        await send(T, chatId, "Usage: /address 0912345678\n\nThis is where your withdrawals are paid.");
      } else {
        const num = raw.startsWith("0") ? raw : "0" + raw.slice(-9);
        await env.WALLET.put("addr:" + userId, num);
        await send(T, chatId, "✅ Telebirr number saved: " + num);
      }
    }

    else if (text.startsWith("/withdraw")) {
      await handleWithdraw(env, T, who, text);
    }

    // ---- admin commands ----
    else if (isAdmin && text.startsWith("/credit")) {
      const p = text.split(/\s+/).slice(1);
      const amount = parseFloat(p[0]);
      const target = p[1] || userId;
      if (!amount || amount <= 0) {
        await send(T, chatId, "Usage: /credit 500 [userId]");
      } else {
        const bal = parseFloat(await env.WALLET.get("bal:" + target) || "0");
        await env.WALLET.put("bal:" + target, String(bal + amount));
        await send(T, chatId, "✅ Credited " + fmt(amount) + " ETB to " + target + ". New balance: " + fmt(bal + amount));
      }
    }

    else if (isAdmin && text.startsWith("/deduct")) {
      const p = text.split(/\s+/).slice(1);
      const amount = parseFloat(p[0]);
      const target = p[1] || userId;
      if (!amount || amount <= 0) {
        await send(T, chatId, "Usage: /deduct 500 userId");
      } else {
        const bal = parseFloat(await env.WALLET.get("bal:" + target) || "0");
        const nb = Math.max(0, bal - amount);
        await env.WALLET.put("bal:" + target, String(nb));
        await send(T, chatId, "✅ Deducted " + fmt(amount) + " ETB from " + target + ". New balance: " + fmt(nb));
      }
    }

    else if (isAdmin && text.startsWith("/done")) {
      const id = text.split(/\s+/)[1];
      const raw = id && await env.WALLET.get("wd:" + id);
      if (!raw) {
        await send(T, chatId, "No withdrawal #" + (id || "") + " found.");
      } else {
        const wd = JSON.parse(raw);
        if (wd.status !== "pending") {
          await send(T, chatId, "Withdrawal #" + id + " is already " + wd.status + ".");
        } else {
          wd.status = "paid";
          await env.WALLET.put("wd:" + id, JSON.stringify(wd));
          await send(T, chatId, "✅ Withdrawal #" + id + " marked as paid (" + fmt(wd.amount) + " ETB to " + wd.addr + ").");
        }
      }
    }

    else if (isAdmin && text.startsWith("/refund")) {
      const id = text.split(/\s+/)[1];
      const raw = id && await env.WALLET.get("wd:" + id);
      if (!raw) {
        await send(T, chatId, "No withdrawal #" + (id || "") + " found.");
      } else {
        const wd = JSON.parse(raw);
        if (wd.status !== "pending") {
          await send(T, chatId, "Withdrawal #" + id + " is already " + wd.status + ".");
        } else {
          wd.status = "refunded";
          await env.WALLET.put("wd:" + id, JSON.stringify(wd));
          const bal = parseFloat(await env.WALLET.get("bal:" + wd.userId) || "0");
          await env.WALLET.put("bal:" + wd.userId, String(bal + wd.amount));
          await send(T, wd.userId, "↩️ Withdrawal #" + id + " was rejected. " + fmt(wd.amount) + " ETB has been returned to your balance.");
          await send(T, chatId, "✅ Withdrawal #" + id + " refunded (" + fmt(wd.amount) + " ETB back to user).");
        }
      }
    }

    // ---- deposit verification ----
    // Triggered by: receipt link, a forwarded/pasted Telebirr SMS,
    // or a bare receipt number.
    else if (text && /telebirr|receipt|transactioninfo|የክፍያ/i.test(text)) {
      await handleReceipt(env, T, who, text, cfg);
    }
    else if (/^[A-Z0-9]{8,16}$/i.test(text)) {
      await handleReceipt(env, T, who, text, cfg);
    }

    else if (msg.photo) {
      await send(T, chatId,
        "📷 Screenshots can't be verified automatically.\n\n" +
        "Send the receipt number, or paste the receipt link from your Telebirr SMS.");
    }

    return new Response("OK");
  },
};

// ---------------- deposit verification ----------------

async function handleReceipt(env, T, who, text, cfg) {
  const receiptNo = extractReceiptNo(text);
  if (!receiptNo) {
    await send(T, who.chatId,
      "🤔 I couldn't find a receipt number in that message.\n\n" +
      "Send the receipt number from your Telebirr SMS, or paste the full receipt link.");
    return;
  }

  const used = await env.WALLET.get("txn:" + receiptNo);
  if (used) {
    await send(T, who.chatId, "❌ This receipt was already used" + (used === who.userId ? "." : " by another user."));
    return;
  }

  await send(T, who.chatId, "⏳ Verifying receipt " + receiptNo + " on the official Telebirr page…");

  let fields;
  try {
    fields = await fetchReceipt(receiptNo);
  } catch (e) {
    await send(T, who.chatId,
      "⚠️ The Telebirr verification page is unreachable right now.\n" +
      "Please try again in a minute — nothing was charged to your balance.");
    return;
  }

  if (!fields || Object.keys(fields).length === 0) {
    await send(T, who.chatId,
      "❌ Receipt " + receiptNo + " was not found on the official page.\n" +
      "Check the number and send it again.");
    return;
  }

  const status = (fields.transaction_status || "").toLowerCase();
  const recipient = (fields.credited_party_name || "").replace(/\s+/g, " ").trim().toLowerCase();
  const expected = (cfg("TELEBIRR_NAME") || "").replace(/\s+/g, " ").trim().toLowerCase();
  const amount = fields.total_amount || fields.settled_amount || 0;

  if (/success/.test(status) && recipient && expected && recipient === expected && amount > 0) {
    const min = parseFloat(cfg("MIN_DEPOSIT")) || 0;
    if (amount < min) {
      await send(T, who.chatId, "❌ Deposit below minimum (" + fmt(min) + " ETB). Nothing was credited.");
      return;
    }
    const bal = parseFloat(await env.WALLET.get("bal:" + who.userId) || "0");
    await env.WALLET.put("bal:" + who.userId, String(bal + amount));
    await env.WALLET.put("txn:" + receiptNo, who.userId);
    await send(T, who.chatId,
      "✅ Deposit confirmed!\n\n" +
      "Amount: " + fmt(amount) + " ETB\n" +
      "Receipt: " + receiptNo + "\n" +
      "New balance: " + fmt(bal + amount) + " ETB");
    await send(T, env.ADMIN_ID,
      "📥 Verified deposit\n" +
      "User: " + who.name + " (" + who.userId + ")\n" +
      "Amount: " + fmt(amount) + " ETB\n" +
      "Receipt: " + receiptNo + "\n" +
      "Payer: " + (fields.payer_name || "?") + " (" + (fields.payer_phone || "?") + ")");
  }

  else if (status && /fail|cancel|pending|revers/.test(status)) {
    await send(T, who.chatId, "❌ The official page shows this transaction as: " + fields.transaction_status + ".\nNothing was credited.");
    await send(T, env.ADMIN_ID,
      "⚠️ Failed-status receipt used\nUser: " + who.name + " (" + who.userId + ")\nReceipt: " + receiptNo);
  }

  else {
    // Name mismatch, missing fields, or a different receipt format
    // -> never auto-credit, let the admin decide.
    await send(T, who.chatId,
      "⚠️ I couldn't verify this receipt automatically.\n" +
      "It has been sent to the admin for manual review. You'll be credited shortly if it's valid.");
    await send(T, env.ADMIN_ID,
      "⚠️ Receipt needs manual review\n\n" +
      "User: " + who.name + " (" + who.userId + ")\n" +
      "Receipt: " + receiptNo + "\n" +
      "Expected recipient: " + cfg("TELEBIRR_NAME") + "\n" +
      "Parsed fields: " + JSON.stringify(fields) + "\n\n" +
      "Check it on:\n" + RECEIPT_SITE + receiptNo + "\n\n" +
      "If valid, credit with:\n/credit " + (amount > 0 ? fmt(amount) : "AMOUNT") + " " + who.userId);
  }
}

function extractReceiptNo(text) {
  const url = text.match(/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Za-z0-9]+)/i);
  if (url) return url[1].toUpperCase();
  const labelled = text.match(/(?:receipt|የክፍያ\s*ቁጥር)\s*(?:no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9]{6,20})/i);
  if (labelled) return labelled[1].toUpperCase();
  const bare = text.trim();
  if (/^[A-Za-z0-9]{8,16}$/.test(bare)) return bare.toUpperCase();
  return null;
}

// Ported from telebirr-receipt (parseFromHTML + loadReceipt),
// rewritten for Workers: fetch() + regex <td> extraction instead
// of Node https + htmlparser2.
async function fetchReceipt(receiptNo) {
  const res = await fetch(RECEIPT_SITE + encodeURIComponent(receiptNo), {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();

  const tds = [];
  const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html)) !== null) tds.push(clean(m[1]));

  const norm = (s) => s.replace(/[\n\r\s\t]/g, "").toLowerCase();
  const names = ['የከፋይስም/payername', 'የከፋይቴሌብርቁ./payertelebirrno.', 'የከፋይአካውንትአይነት/payeraccounttype', 'የገንዘብተቀባይስም/creditedpartyname', 'የገንዘብተቀባይቴሌብርቁ./creditedpartyaccountno', 'የክፍያውሁኔታ/transactionstatus', 'የባንክአካውንትቁጥር/bankaccountnumber', 'የክፍያቁጥር/receiptno.', 'የክፍያቀን/paymentdate', 'የተከፈለውመጠን/settledamount', 'ቅናሽ/discountamount', '15%ቫት/vat', 'ጠቅላላየተክፈለ/totalamountpaid', 'የገንዘቡልክበፊደል/totalamountinword', 'የክፍያዘዴ/paymentmode', 'የክፍያምክንያት/paymentreason', 'የክፍያመንገድ/paymentchannel'];
  const keys = ['payer_name', 'payer_phone', 'payer_acc_type', 'credited_party_name', 'credited_party_acc_no', 'transaction_status', 'bank_acc_no', 'receiptNo', 'date', 'settled_amount', 'discount_amount', 'vat_amount', 'total_amount', 'amount_in_word', 'payment_mode', 'payment_reason', 'payment_channel'];

  const fields = {};
  tds.forEach((cell, i) => {
    const idx = names.indexOf(norm(cell));
    if (idx < 0) return;
    let j = i + 1;
    if (idx > 6 && idx <= 9) j += 1; // rows with an extra empty cell (same offset as the original library)
    const next = tds[j] !== undefined ? tds[j] : "";
    const key = keys[idx];
    if (key === "bank_acc_no") {
      fields.to = next.replace(/^[0-9]+/g, "").trim();
      fields[key] = next.replace(/[A-Z]/gi, "").trim();
    } else if (key.endsWith("amount")) {
      fields[key] = parseFloat(next.replace(/birr/ig, "").trim()) || 0;
    } else {
      fields[key] = next;
    }
  });
  return fields;
}

function clean(s) {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------- withdrawals ----------------

async function handleWithdraw(env, T, who, text) {
  const bal = parseFloat(await env.WALLET.get("bal:" + who.userId) || "0");
  const addr = await env.WALLET.get("addr:" + who.userId);

  if (bal <= 0) {
    await send(T, who.chatId, "❌ Your balance is 0 ETB. Use 💵 Deposit first.");
  } else if (!addr) {
    await send(T, who.chatId,
      "📮 Register the Telebirr number your withdrawals go to:\n\n/address 09XXXXXXXX");
  } else if (!text.includes(" ")) {
    await send(T, who.chatId,
      "💼 Balance: " + fmt(bal) + " ETB\n\nTo withdraw, send:\n/withdraw AMOUNT\n\nExample: /withdraw 500");
  } else {
    const amount = parseFloat(text.split(/\s+/)[1]);
    if (!amount || amount <= 0) {
      await send(T, who.chatId, "❌ Invalid amount.");
    } else if (amount > bal) {
      await send(T, who.chatId, "❌ Insufficient balance. You have " + fmt(bal) + " ETB.");
    } else {
      const id = String(parseInt(await env.WALLET.get("wd:counter") || "0", 10) + 1);
      await env.WALLET.put("wd:counter", id);
      await env.WALLET.put("wd:" + id, JSON.stringify({ userId: who.userId, name: who.name, amount, addr, status: "pending" }));
      await env.WALLET.put("bal:" + who.userId, String(bal - amount));
      await send(T, who.chatId,
        "🏧 Withdrawal #" + id + " requested\n\n" +
        "Amount: " + fmt(amount) + " ETB\n" +
        "Paid to: " + addr + "\n\nYou'll receive it shortly.");
      await send(T, env.ADMIN_ID,
        "🏧 Withdrawal #" + id + "\n" +
        "User: " + who.name + " (" + who.userId + ")\n" +
        "Amount: " + fmt(amount) + " ETB\n" +
        "Pay to Telebirr: " + addr + "\n\n" +
        "When paid → /done " + id + "\n" +
        "To reject → /refund " + id);
    }
  }
}

// ---------------- shared helpers ----------------

function menu() {
  return {
    reply_markup: {
      keyboard: [[{ text: "💵 Deposit" }, { text: "💰 Balance" }]],
      resize_keyboard: true
    }
  };
}

function fmt(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

async function send(token, chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra })
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("✅ Wallet bot is running");
    }

    const update = await request.json();
    const msg = update.message;
    if (!msg || !msg.text) return new Response("OK");

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text.trim();
    const T = env.BOT_TOKEN;

    if (text === "/start") {
      if ((await env.WALLET.get("bal:" + userId)) === null) {
        await env.WALLET.put("bal:" + userId, "0");
      }
      await send(T, chatId, "👋 *Welcome to Wallet Bot!*\n\nChoose an option 👇", menu());
    }

    else if (text === "💰 Balance" || text === "/balance") {
      const bal = await env.WALLET.get("bal:" + userId) || "0";
      await send(T, chatId, `💼 *Your balance:* ${bal} USDT`);
    }

    else if (text === "💵 Deposit" || text === "/deposit") {
      await send(T, chatId,
        "💵 *How to deposit:*\n\n" +
        "Send USDT (TRC20) to:\n`PASTE_YOUR_WALLET_ADDRESS_HERE`\n\n" +
        "Minimum: 1 USDT\nCredited after 1 network confirmation.\n\n" +
        "_⚠️ USDT TRC20 only — other assets will be lost._");
    }

    else if (text === "🏧 Withdraw" || text.startsWith("/withdraw")) {
      const bal = parseFloat(await env.WALLET.get("bal:" + userId) || "0");

      if (bal <= 0) {
        await send(T, chatId, "❌ Your balance is 0. Use 💵 Deposit first.");
      } else if (!text.includes(" ")) {
        await send(T, chatId,
          `💼 Balance: *${bal} USDT*\n\nTo withdraw, send:\n` +
          "`/withdraw AMOUNT`\n\nExample: `/withdraw 10`");
      } else {
        const amount = parseFloat(text.split(" ")[1]);
        if (!amount || amount <= 0) {
          await send(T, chatId, "❌ Invalid amount.");
        } else if (amount > bal) {
          await send(T, chatId, `❌ Insufficient balance. You have ${bal} USDT.`);
        } else {
          await env.WALLET.put("bal:" + userId, String(bal - amount));
          await send(T, chatId,
            `✅ *Withdrawal received*\n\nAmount: ${amount} USDT\n` +
            `Remaining: ${bal - amount} USDT\n\nProcessed within 24h.`);
        }
      }
    }

    // Admin only — used to add test balance
    else if (text.startsWith("/credit")) {
      if (userId !== env.ADMIN_ID) return new Response("OK");
      const amount = parseFloat(text.split(" ")[1]);
      if (!amount || amount <= 0) {
        await send(T, chatId, "Usage: `/credit 100`");
      } else {
        const bal = parseFloat(await env.WALLET.get("bal:" + userId) || "0");
        await env.WALLET.put("bal:" + userId, String(bal + amount));
        await send(T, chatId, `✅ Credited ${amount}. New balance: ${bal + amount} USDT`);
      }
    }

    return new Response("OK");
  },
};

function menu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "💵 Deposit" }, { text: "💰 Balance" }],
        [{ text: "🏧 Withdraw" }]
      ],
      resize_keyboard: true
    }
  };
}

async function send(token, chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", ...extra })
  });
}

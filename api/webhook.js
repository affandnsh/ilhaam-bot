if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        const orderJson = JSON.parse(parts[1].trim());
        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        // Match your exact Supabase schema
        await supabase.from("orders").insert({
          order_number: orderNum,
          total: orderJson.total || 0,
          subtotal: orderJson.total || 0,
          status: "new",
          payment_status: "pending"
        });

        replyText += `\n\n✅ *Order Confirmed!* Order Number: *${orderNum}*.`;
      }

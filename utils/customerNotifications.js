import { createClient } from "@supabase/supabase-js";
import { sendCrmWhatsappText, sendCrmWhatsappTemplate } from "../whatsapp-crm.js";
import { normalizePhone } from "../phoneUtils.js";

const BIRTHDAY_TEMPLATE = "birthday_wish";
const PASSPORT_6MONTHS_TEMPLATE = "passport_expiry_6months";
const PASSPORT_2DAYS_TEMPLATE = "passport_expiry_2days";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Append activity to customer's activity log
 */
async function appendCustomerActivity(customerId, type, description, user = "System") {
  try {
    const { data: customer, error: fetchError } = await supabase
      .from("customers")
      .select("activity")
      .eq("id", customerId)
      .single();

    if (fetchError || !customer) {
      console.error(`[Notifications] Failed to fetch customer ${customerId}:`, fetchError?.message);
      return;
    }

    const newActivity = {
      id: Date.now(),
      type,
      description,
      user,
      timestamp: new Date().toISOString(),
    };

    const updatedActivity = [newActivity, ...(customer.activity || [])];

    const { error: updateError } = await supabase
      .from("customers")
      .update({ activity: updatedActivity })
      .eq("id", customerId);

    if (updateError) {
      console.error(`[Notifications] Failed to log activity for customer ${customerId}:`, updateError.message);
    } else {
      console.log(`[Notifications] ✅ Logged '${type}' for customer ${customerId}`);
    }
  } catch (error) {
    console.error(`[Notifications] Error logging activity for customer ${customerId}:`, error.message);
  }
}

/**
 * Send birthday WhatsApp message and log activity
 */
async function sendBirthdayMessage(customer) {
  try {
    if (!customer.phone) {
      console.warn(`[Notifications] Customer ${customer.id} (${customer.first_name} ${customer.last_name}) has no phone number, skipping birthday message`);
      return;
    }

    const phone = normalizePhone(customer.phone, "IN");
    if (!phone) {
      console.warn(`[Notifications] Invalid phone number for customer ${customer.id}`);
      return;
    }

    const customerName = `${customer.first_name} ${customer.last_name}`.trim() || "Valued Customer";

    console.log(`[Notifications] 📤 Sending birthday template to ${customerName} (${phone})`);

    const components = [
      { type: "body", parameters: [{ type: "text", text: customerName }] },
    ];
    let result = await sendCrmWhatsappTemplate(phone, BIRTHDAY_TEMPLATE, "en", components);
    if (!result) {
      const fallback = `🎉 Happy Birthday ${customerName}! 🎂\n\nWishing you a wonderful day filled with joy, happiness, and amazing adventures ahead! Thank you for being part of the Madura Travel family. Have a fantastic year ahead! 🌟`;
      result = await sendCrmWhatsappText(phone, fallback);
    }
    
    if (result && result.messages && result.messages[0]) {
      const messageId = result.messages[0].id;
      const status = result.messages[0].message_status || "sent";
      
      await appendCustomerActivity(
        customer.id,
        "Birthday Wish",
        `Birthday wish sent successfully via WhatsApp. Message ID: ${messageId}. Status: ${status}`,
        "System"
      );
      
      console.log(`[Notifications] ✅ Birthday message sent to ${customerName}. Message ID: ${messageId}`);
    } else {
      const errorDesc = "Birthday wish failed to send via WhatsApp. Check server/PM2 logs for details (token, re-engagement, or network).";
      await appendCustomerActivity(customer.id, "Birthday Wish (Failed)", errorDesc, "System");
      console.error(`[Notifications] ❌ Failed to send birthday message to ${customerName}. Logged to customer activity.`);
    }
  } catch (error) {
    const errMsg = error?.message || String(error);
    await appendCustomerActivity(
      customer.id,
      "Birthday Wish (Error)",
      `Error sending birthday wish: ${errMsg}`,
      "System"
    );
    console.error(`[Notifications] Error sending birthday message to customer ${customer.id}:`, errMsg);
  }
}

/**
 * Send passport expiry notification and log activity
 */
async function sendPassportExpiryNotification(customer, daysUntilExpiry, expiryDate) {
  try {
    if (!customer.phone) {
      console.warn(`[Notifications] Customer ${customer.id} has no phone number, skipping passport expiry notification`);
      return;
    }

    const phone = normalizePhone(customer.phone, "IN");
    if (!phone) {
      console.warn(`[Notifications] Invalid phone number for customer ${customer.id}`);
      return;
    }

    const customerName = `${customer.first_name} ${customer.last_name}`.trim() || "Valued Customer";
    const passportNumber = customer.passport_number || "your passport";
    const expiryDateStr = new Date(expiryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    
    const templateName = daysUntilExpiry === 2 ? PASSPORT_2DAYS_TEMPLATE : PASSPORT_6MONTHS_TEMPLATE;
    const components = [
      { type: "body", parameters: [{ type: "text", text: passportNumber }, { type: "text", text: expiryDateStr }] },
    ];

    console.log(`[Notifications] 📤 Sending passport expiry template "${templateName}" to ${customerName} (${phone}) - ${daysUntilExpiry} days until expiry`);

    let result = await sendCrmWhatsappTemplate(phone, templateName, "en", components);
    if (!result) {
      const message = daysUntilExpiry === 2
        ? `⚠️ Reminder: Your passport (${passportNumber}) will expire in 2 days (${expiryDateStr}).\n\nPlease renew your passport soon to avoid any travel disruptions. If you need assistance, we're here to help!\n\n- Madura Travel`
        : `📋 Passport Expiry Reminder: Your passport (${passportNumber}) will expire in approximately 6 months (${expiryDateStr}).\n\nWe recommend renewing your passport well in advance to ensure smooth travel planning. If you need any assistance, please contact us.\n\n- Madura Travel`;
      result = await sendCrmWhatsappText(phone, message);
    }
    
    if (result && result.messages && result.messages[0]) {
      const messageId = result.messages[0].id;
      const status = result.messages[0].message_status || "sent";
      
      const notificationType = daysUntilExpiry === 2 ? "Passport Expiry (2 days)" : "Passport Expiry (6 months)";
      
      await appendCustomerActivity(
        customer.id,
        notificationType,
        `Passport expiry notification sent via WhatsApp. Expiry date: ${expiryDateStr}. Days remaining: ${daysUntilExpiry}. Message ID: ${messageId}. Status: ${status}`,
        "System"
      );
      
      console.log(`[Notifications] ✅ Passport expiry notification sent to ${customerName}. Message ID: ${messageId}`);
    } else {
      const errorDesc = "Passport expiry notification failed to send via WhatsApp. Check server/PM2 logs for details.";
      await appendCustomerActivity(customer.id, "Passport Expiry (Failed)", errorDesc, "System");
      console.error(`[Notifications] ❌ Failed to send passport expiry notification to ${customerName}. Logged to customer activity.`);
    }
  } catch (error) {
    const errMsg = error?.message || String(error);
    await appendCustomerActivity(
      customer.id,
      "Passport Expiry (Error)",
      `Error sending passport expiry notification: ${errMsg}`,
      "System"
    );
    console.error(`[Notifications] Error sending passport expiry notification to customer ${customer.id}:`, errMsg);
  }
}

/**
 * Check and send birthday messages for customers whose birthday is today
 */
export async function checkBirthdays() {
  try {
    const now = new Date();
    const istDateStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD in IST
    const [todayYear, todayMonth, todayDay] = istDateStr.split("-").map(Number);
    console.log(`[Notifications] 🎂 Checking for birthdays (IST date: ${istDateStr})...`);

    const { data: customers, error } = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone, date_of_birth")
      .not("date_of_birth", "is", null)
      .not("phone", "is", null);

    if (error) {
      console.error(`[Notifications] Error fetching customers for birthday check:`, error.message);
      return;
    }

    if (!customers || customers.length === 0) {
      console.log(`[Notifications] No customers with date of birth found`);
      return;
    }

    const birthdayCustomers = customers.filter((customer) => {
      if (!customer.date_of_birth) return false;
      const dobStr = String(customer.date_of_birth).split("T")[0];
      const parts = dobStr.split("-").map(Number);
      if (parts.length < 3) return false;
      const dobMonth = parts[1];
      const dobDay = parts[2];
      return dobMonth === todayMonth && dobDay === todayDay;
    });

    console.log(`[Notifications] Found ${birthdayCustomers.length} customers with birthdays today`);

    for (const customer of birthdayCustomers) {
      // Check if we already sent a birthday wish today (to avoid duplicates)
      const { data: existingCustomer } = await supabase
        .from("customers")
        .select("activity")
        .eq("id", customer.id)
        .single();

      const todayActivity = (existingCustomer?.activity || []).find((act) => {
        if (act.type === "Birthday Wish" && act.timestamp) {
          const actDateIST = new Date(act.timestamp).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
          return actDateIST === istDateStr;
        }
        return false;
      });

      if (todayActivity) {
        console.log(`[Notifications] ⏭️ Birthday wish already sent today for customer ${customer.id}, skipping`);
        continue;
      }

      await sendBirthdayMessage(customer);
      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`[Notifications] ✅ Birthday check completed`);
  } catch (error) {
    console.error(`[Notifications] Error in birthday check:`, error.message);
  }
}

/**
 * Check and send passport expiry notifications
 */
export async function checkPassportExpiries() {
  try {
    console.log(`[Notifications] 📋 Checking for passport expiries...`);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get all customers with passport_expiry_date
    const { data: customers, error } = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone, passport_number, passport_expiry_date")
      .not("passport_expiry_date", "is", null)
      .not("phone", "is", null);

    if (error) {
      console.error(`[Notifications] Error fetching customers for passport expiry check:`, error.message);
      return;
    }

    if (!customers || customers.length === 0) {
      console.log(`[Notifications] No customers with passport expiry dates found`);
      return;
    }

    const notificationsToSend = [];

    for (const customer of customers) {
      if (!customer.passport_expiry_date) continue;

      const expiryDate = new Date(customer.passport_expiry_date);
      expiryDate.setHours(0, 0, 0, 0);
      
      const daysUntilExpiry = Math.floor((expiryDate - today) / (1000 * 60 * 60 * 24));

      // Check for 6 months before (approximately 180 days, with some tolerance)
      const sixMonthsFromNow = new Date(today);
      sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
      const daysUntilSixMonths = Math.floor((sixMonthsFromNow - today) / (1000 * 60 * 60 * 24));
      
      // Check if expiry is approximately 6 months away (±5 days tolerance)
      if (daysUntilExpiry >= 175 && daysUntilExpiry <= 185) {
        // Check if we already sent a 6-month notification for this expiry date
        const { data: existingCustomer } = await supabase
          .from("customers")
          .select("activity")
          .eq("id", customer.id)
          .single();

        const alreadyNotified = (existingCustomer?.activity || []).some(act => {
          if (act.type === "Passport Expiry (6 months)" && act.description) {
            return act.description.includes(customer.passport_expiry_date);
          }
          return false;
        });

        if (!alreadyNotified) {
          notificationsToSend.push({ customer, daysUntilExpiry, expiryDate: customer.passport_expiry_date });
        }
      }
      // Check for 2 days before
      else if (daysUntilExpiry === 2) {
        const { data: existingCustomer } = await supabase
          .from("customers")
          .select("activity")
          .eq("id", customer.id)
          .single();

        const alreadyNotified = (existingCustomer?.activity || []).some(act => {
          if (act.type === "Passport Expiry (2 days)" && act.description) {
            return act.description.includes(customer.passport_expiry_date);
          }
          return false;
        });

        if (!alreadyNotified) {
          notificationsToSend.push({ customer, daysUntilExpiry: 2, expiryDate: customer.passport_expiry_date });
        }
      }
      // On expiry date (today) - not used; we only send 6 months and 2 days before
    }

    console.log(`[Notifications] Found ${notificationsToSend.length} passport expiry notifications to send`);

    for (const { customer, daysUntilExpiry, expiryDate } of notificationsToSend) {
      await sendPassportExpiryNotification(customer, daysUntilExpiry, expiryDate);
      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`[Notifications] ✅ Passport expiry check completed`);
  } catch (error) {
    console.error(`[Notifications] Error in passport expiry check:`, error.message);
  }
}

/**
 * Schedule daily checks for birthdays and passport expiries
 */
export function scheduleCustomerNotifications() {
  // Run checks once per day at 12:01 AM IST (6:31 PM UTC previous day)
  const CHECK_HOUR = 0; // 12 AM IST (midnight)
  const CHECK_MINUTE = 1; // 1 minute past midnight

  function runChecks() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    console.log(`[Notifications] 🕘 Running scheduled customer notifications check at ${istTime.toLocaleString()}`);
    
    checkBirthdays();
    checkPassportExpiries();
  }

  // Run immediately on startup (for testing/debugging)
  console.log(`[Notifications] 🚀 Starting customer notifications scheduler`);
  runChecks();

  // Calculate time until next 9 AM IST
  function scheduleNextRun() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    
    let nextRun = new Date(istTime);
    nextRun.setHours(CHECK_HOUR, CHECK_MINUTE, 0, 0);
    
    // If it's already past 12:01 AM today, schedule for tomorrow
    if (istTime >= nextRun) {
      nextRun.setDate(nextRun.getDate() + 1);
    }
    
    const msUntilNextRun = nextRun.getTime() - istTime.getTime();
    
    console.log(`[Notifications] ⏰ Next notification check scheduled for ${nextRun.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })} (12:01 AM IST)`);
    
    setTimeout(() => {
      runChecks();
      scheduleNextRun(); // Schedule the next run
    }, msUntilNextRun);
  }

  scheduleNextRun();
}

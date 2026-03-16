import puppeteer from "puppeteer";
import {
  getChromiumPathForLaunch,
  validateChromiumPath,
} from "./utils/chromiumHelper.js";
import { createClient } from "@supabase/supabase-js";
import { logger } from "./utils/logger.js";

const pdfLog = (...args) => {
  if (process.env.PDF_DEBUG) console.log(...args);
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Number to words converter
function numberToWords(num) {
  const a = [
    "",
    "one ",
    "two ",
    "three ",
    "four ",
    "five ",
    "six ",
    "seven ",
    "eight ",
    "nine ",
    "ten ",
    "eleven ",
    "twelve ",
    "thirteen ",
    "fourteen ",
    "fifteen ",
    "sixteen ",
    "seventeen ",
    "eighteen ",
    "nineteen ",
  ];
  const b = [
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
  ];
  const s = Math.floor(num).toString();
  if (s.length > 9) return "overflow";
  const n = ("000000000" + s)
    .substr(-9)
    .match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
  if (!n) return "";
  let str = "";
  str +=
    parseInt(n[1]) !== 0
      ? (a[Number(n[1])] || b[n[1][0]] + " " + a[n[1][1]]) + "crore "
      : "";
  str +=
    parseInt(n[2]) !== 0
      ? (a[Number(n[2])] || b[n[2][0]] + " " + a[n[2][1]]) + "lakh "
      : "";
  str +=
    parseInt(n[3]) !== 0
      ? (a[Number(n[3])] || b[n[3][0]] + " " + a[n[3][1]]) + "thousand "
      : "";
  str +=
    parseInt(n[4]) !== 0
      ? (a[Number(n[4])] || b[n[4][0]] + " " + a[n[4][1]]) + "hundred "
      : "";
  str +=
    parseInt(n[5]) !== 0
      ? (str !== "" ? "and " : "") +
        (a[Number(n[5])] || b[n[5][0]] + " " + a[n[5][1]])
      : "";
  str = str.trim();
  if (str === "") return "Zero";
  return str.charAt(0).toUpperCase() + str.slice(1) + " Only";
}

// Generate invoice HTML
function generateInvoiceHtml(data) {
  const {
    invoice,
    customer,
    branch,
    lead,
    actualAmountPaid = 0, // Amount paid from payments table
    payUrl = "", // Razorpay link for QR: invoice-specific or HQ (branch 1) default
  } = data;

  const amountPaid = (invoice.total_amount || 0) - (invoice.balance_due || 0);
  const subtotal = (invoice.items || []).reduce(
    (acc, item) => acc + (item.amount || 0),
    0,
  );
  const discount = invoice.discount_amount || 0;
  const subAfterDiscount = subtotal - discount;
  const gstPercent =
    invoice.gst_percentage !== undefined && invoice.gst_percentage !== null
      ? invoice.gst_percentage
      : 5;
  const calculatedGst = subAfterDiscount * (gstPercent / 100);

  const cgst = invoice.cgst_amount ?? calculatedGst / 2;
  const sgst = invoice.sgst_amount ?? calculatedGst / 2;
  const tcs = invoice.tcs_amount || 0;
  const total = invoice.total_amount || 0;

  // Display name: prefer invoice billing_name, then display_name, then company/customer name
  const displayName =
    (invoice.billing_name && invoice.billing_name.trim()) ||
    invoice.display_name ||
    (customer.company && customer.gst_number
      ? customer.company
      : `${customer.first_name} ${customer.last_name}`);

  // Address: prefer invoice billing_address (from form); fallback to customer address object
  const rawBillingAddress =
    invoice.billing_address && invoice.billing_address.trim();
  const countryAndZip = customer.address
    ? (customer.address.country || "") +
      (customer.address.zip ? ` - ${customer.address.zip}` : "")
    : "";
  const fallbackAddressParts = customer.address
    ? [
        customer.address.street,
        customer.address.city,
        customer.address.state,
        countryAndZip,
      ].filter(Boolean)
    : [];
  const customerAddress =
    rawBillingAddress ||
    (fallbackAddressParts.length > 0 ? fallbackAddressParts.join(", ") : "");

  // Format MTS ID string: MTS-{lead_id} - {duration} {destination} Tour Package x {adults}A+{children}C
  const formattedMTSId =
    lead && lead.id
      ? (() => {
          const leadId = lead.id;
          const duration = lead.duration || "";
          const destination = lead.destination || "";
          const adults = lead.requirements?.adults || 0;
          const children = lead.requirements?.children || 0;
          return `MTS-${leadId} - ${duration} ${destination} Tour Package x ${adults}A+${children}C`;
        })()
      : null;

  // Get default bank details
  const defaultBankDetails =
    branch.bank_details && branch.bank_details.length > 0
      ? branch.bank_details.find((bd) => bd.is_default) ||
        branch.bank_details[0]
      : null;

  // Only show cheque text, not the full terms
  const chequeText =
    "All Cheques / Drafts in payment of bills must be crossed 'A/c Payee Only' and drawn in favour of 'MADURA TRAVEL SERVICE (P) LTD.'.";

  // Format date
  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Invoice ${invoice.invoice_number}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        body {
            font-family: 'Inter', 'Arial', sans-serif;
            font-size: 10px;
            color: #1e293b;
            background: #f9fafb;
            padding: 0;
            margin: 0;
            line-height: 1.4;
            position: relative;
        }
        .invoice-container {
            width: 100%;
            max-width: 8in;
            min-height: 100vh;
            background: #fff;
            position: relative;
            margin: 0 auto;
            padding: 16px 20px;
            padding-bottom: 24px;
            box-sizing: border-box;
        }
        section, .card, .customer-card, .table-card, .totals-card, .footer-card, .hero-section {
            page-break-inside: avoid;
        }
        
        /* Hero Section - Trip Summary */
        .hero-section {
            background: linear-gradient(135deg, #191974 0%, #0f172a 100%);
            color: #fff;
            padding: 20px 24px; 
            border-radius: 8px;
            margin-bottom: 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .hero-left {
            flex: 1;
        }
        .hero-trip-title {
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 8px;
            color: #fff;
        }
        .hero-trip-details {
            font-size: 9px;
            color: #d1d5db;
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
        }
        .hero-trip-details span {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .hero-right {
            text-align: right;
        }
        .hero-invoice-number {
            font-size: 11px;
            color: #d1d5db;
            margin-bottom: 4px;
        }
        .hero-amount {
            font-size: 20px;
            font-weight: bold;
            color: #fff;
        }
        .hero-balance {
            font-size: 9px;
            color: #fca5a5;
            margin-top: 4px;
        }
        
        /* Header */
        header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            padding-bottom: 10px;
            border-bottom: 1px solid #e2e8f0;
            margin-bottom: 14px;
        }
        .header-left {
            flex: 1;
        }
        .header-left img {
            height: 48px;
            width: auto;
            margin-bottom: 4px;
        }
        .header-left h1 {
            font-size: 14px;
            font-weight: 700;
            margin-bottom: 4px;
            color: #1e293b;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .header-left p {
            font-size: 10px;
            color: #475569;
            margin: 1px 0;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .header-right {
            text-align: right;
        }
        .header-right h2 {
            font-size: 18px;
            font-weight: 700;
            text-transform: uppercase;
            color: #374151;
            margin-bottom: 4px;
            letter-spacing: 0;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .header-right .invoice-meta {
            background: #f1f5f9;
            padding: 8px 10px;
            border-radius: 4px;
            display: inline-block;
            text-align: left;
            margin-top: 4px;
        }
        .header-right .invoice-meta p {
            margin: 1px 0;
            font-size: 10px;
            color: #374151;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .header-right .invoice-meta span {
            font-weight: 600;
            color: #1e293b;
        }
        
        /* Card-based Sections */
        .card {
            background: #fff;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 16px 20px;
            margin-bottom: 20px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        }
        .card-title {
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            color: #191974;
            letter-spacing: 0.05em;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 2px solid #191974;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        
        /* Two-column layout for customer details */
        .customer-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 0;
        }
        .customer-card {
            background: #fff;
            border: none;
            border-radius: 0;
            padding: 0;
        }
        .customer-card h3 {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            color: #6b7280;
            letter-spacing: 0.05em;
            margin-bottom: 2px;
            padding-bottom: 0;
            border-bottom: none;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .customer-card .display-name {
            font-size: 10px;
            font-weight: 700;
            color: #1e293b;
            margin-bottom: 2px;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .customer-card p {
            font-size: 10px;
            color: #475569;
            margin: 1px 0;
            line-height: 1.4;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .customer-card strong {
            color: #1e293b;
            font-weight: 600;
        }
        
        section {
            margin: 12px 0;
        }
        /* Table – auto layout so all values visible, smaller font */
        .table-card {
            background: #fff;
            border: none;
            padding: 0;
            overflow: visible;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: auto;
            font-size: 9px;
        }
        table th:first-child,
        table td:first-child {
            min-width: 0;
            text-align: left;
            padding: 4px 6px;
            white-space: normal;
            word-wrap: break-word;
            overflow-wrap: break-word;
            vertical-align: top;
            line-height: 1.3;
        }
        thead {
            background: #191974;
            color: #fff;
        }
        th {
            padding: 4px 6px;
            text-align: left;
            font-weight: 600;
            vertical-align: middle;
            font-size: 9px;
            text-transform: none;
            letter-spacing: 0;
            font-family: 'Inter', 'Arial', sans-serif;
            white-space: nowrap;
            line-height: 1.3;
        }
        th.text-right {
            text-align: right;
        }
        th.text-center {
            text-align: center;
        }
        tbody tr {
            border-bottom: 1px solid #f3f4f6;
        }
        tbody tr:nth-child(even) {
            background: #f9fafb;
        }
        td {
            padding: 4px 6px;
            vertical-align: top;
            font-size: 9px;
            white-space: nowrap;
            color: #374151;
            font-family: 'Inter', 'Arial', sans-serif;
            overflow: visible;
            text-overflow: clip;
        }
        table td:first-child {
            white-space: normal;
        }
        td.text-right {
            text-align: right;
        }
        td.text-center {
            text-align: center;
        }
        .item-cell {
            padding: 4px 6px;
        }
        .item-name {
            color: #1e293b;
            font-weight: 600;
            font-size: 9px;
            margin-bottom: 1px;
            display: block;
            line-height: 1.3;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .item-description {
            color: #64748b;
            font-size: 8px;
            line-height: 1.3;
            display: block;
            margin-top: 1px;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .totals-card {
            background: #fff;
            border: none;
            padding: 0;
            margin-top: 12px;
            width: 100%;
            box-sizing: border-box;
        }
        .totals-with-qr-wrapper {
            display: flex;
            align-items: flex-start;
            justify-content: flex-start;
            gap: 20px;
            width: 100%;
            flex-wrap: wrap;
            margin-left: 0;
            padding-left: 0;
        }
        .pay-qr-column {
            flex-shrink: 0;
            text-align: center;
        }
        .pay-qr-column .pay-here-title {
            font-size: 11px;
            font-weight: 700;
            color: #1e293b;
            margin-top: 6px;
            margin-bottom: 0;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .pay-qr-column a {
            display: inline-block;
        }
        .pay-qr-column img {
            display: block;
            width: 100px;
            height: 100px;
        }
        .totals {
            display: flex;
            justify-content: flex-end;
            width: 100%;
            flex: 1;
            min-width: 200px;
            margin-left: auto;
        }
        .totals-inner {
            width: 50%;
            max-width: 400px;
            margin-left: auto;
            box-sizing: border-box;
        }
        .totals-row {
            display: flex;
            justify-content: space-between;
            margin: 1px 0;
            font-size: 10px;
            padding: 1px 0;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .totals-row.red {
            color: #dc2626;
        }
        .totals-row.bold {
            font-weight: 700;
            font-size: 12px;
            padding: 3px 0;
            border-top: none;
            margin: 0;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .totals-row.balance {
            padding: 2px 0;
            background: transparent;
            border-radius: 0;
            font-weight: 600;
            font-size: 10px;
            margin-top: 2px;
            border: none;
            margin-bottom: 0;
            width: 100%;
            box-sizing: border-box;
            display: flex;
            justify-content: space-between;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .totals-row.balance span:last-child {
            color: #16a34a;
        }
        hr {
            border: none;
            border-top: 1px solid #e5e7eb;
            margin: 4px 0;
            padding: 0;
            height: 0;
            line-height: 0;
        }
        footer {
            margin-top: 16px;
            padding-top: 10px;
            border-top: 1px solid #e5e7eb;
            position: relative;
            width: 100%;
            box-sizing: border-box;
        }
        .footer-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 10px;
            width: 100%;
            box-sizing: border-box;
        }
        .footer-card {
            background: transparent;
            padding: 0;
            border-radius: 0;
            border: none;
        }
        .footer-card h4 {
            font-weight: 700;
            font-size: 10px;
            color: #1e293b;
            margin-bottom: 2px;
            text-transform: none;
            letter-spacing: 0;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .footer-card p {
            margin: 1px 0;
            font-size: 10px;
            color: #374151;
            line-height: 1.4;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .footer-card span {
            font-weight: 600;
            color: #1e293b;
        }
        .signature-space {
            height: 36px;
        }
        .signature-line {
            border-top: 1px solid #1e293b;
            padding-top: 2px;
            font-size: 10px;
            color: #374151;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .terms {
            margin-top: 10px;
            padding-top: 6px;
            border-top: 1px solid #e2e8f0;
            width: 100%;
            display: block;
            box-sizing: border-box;
        }
        .terms h4 {
            font-weight: 700;
            font-size: 10px;
            color: #1e293b;
            margin-bottom: 2px;
            text-transform: none;
            letter-spacing: 0;
            font-family: 'Inter', 'Arial', sans-serif;
        }
        .terms-content {
            font-size: 10px;
            color: #475569;
            line-height: 1.4;
            font-family: 'Inter', 'Arial', sans-serif;
            width: 100%;
            max-width: 100%;
            display: block;
            word-wrap: break-word;
            overflow-wrap: break-word;
            white-space: normal;
            word-spacing: normal;
            letter-spacing: normal;
        }
        .terms-content ul {
            list-style-type: disc;
            padding-left: 20px;
            margin: 6px 0;
        }
        .terms-content li {
            margin: 4px 0;
        }
        .terms-content p {
            margin: 4px 0;
        }
        .digital-footer {
            position: absolute;
            bottom: 8px;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 8px;
            color: #9ca3af;
            font-style: italic;
            font-family: 'Inter', 'Arial', sans-serif;
            width: 100%;
            margin: 0;
            padding: 0;
        }
    </style>
</head>
<body>
    <div class="invoice-container">
        <header>
            <div class="header-left">
                ${
                  branch.logo_url
                    ? `<img src="${branch.logo_url}" alt="Company Logo" />`
                    : ""
                }
                <h1>MADURA TRAVEL SERVICE (P) LTD.</h1>
                <p>OLD NO 11-3, NEW NO 25-3 GANDHI IRWIN ROAD OPP. EGMORE RAILWAY STATION,</p>
                <p>EGMORE, CHENNAI. 600-008.</p>
                <p>Phone : +91 90929 49494</p>
                <p>Email : mail@maduratravel.com &nbsp; Website : www.maduratravel.com</p>
                <p>PAN : AACCM4908J</p>
                <p>GSTIN : 33AACCM4908J1ZJ (TAMIL NADU)</p>
            </div>
            <div class="header-right">
                <h2>Tax Invoice</h2>
                <div class="invoice-meta">
                    <p><span>Invoice #:</span> ${
                      invoice.invoice_number || ""
                    }</p>
                    <p><span>IATA No.:</span> 14:3:36420</p>
                    <p><span>Date:</span> ${formatDate(invoice.issue_date)}</p>
                    <p><span>Due Date:</span> ${formatDate(
                      invoice.due_date,
                    )}</p>
                </div>
            </div>
        </header>

        <section style="margin: 12px 0;">
            <div class="customer-grid">
                <div class="customer-card">
                    <h3>Bill To</h3>
                    <p class="display-name">${displayName}</p>
                    ${
                      customerAddress
                        ? `<p style="white-space: pre-line;">${String(
                            rawBillingAddress || customerAddress,
                          )
                            .replace(/&/g, "&amp;")
                            .replace(/</g, "&lt;")
                            .replace(/>/g, "&gt;")
                            .replace(/"/g, "&quot;")}</p>`
                        : ""
                    }
                    ${customer.email ? `<p>${customer.email}</p>` : ""}
                    ${customer.phone ? `<p>${customer.phone}</p>` : ""}
                    ${
                      customer.gst_number
                        ? `<p><strong>GST:</strong> ${customer.gst_number}</p>`
                        : ""
                    }
                </div>
                <div class="customer-card" style="text-align: right;">
                    <h3>Place of Supply</h3>
                    <p style="font-size: 10px; font-weight: 600; color: #1e293b; margin-top: 8px; font-family: 'Inter', 'Arial', sans-serif;">TAMIL NADU (33)</p>
                </div>
            </div>
        </section>
        

        <section>
            <div class="table-card">
                <table>
                <thead>
                    <tr>
                        <th class="text-left">Narration / Description</th>
                        <th class="text-center">SAC</th>
                        <th class="text-center">Qty</th>
                        <th class="text-right">Rate (₹)</th>
                        <th class="text-right">Service Fees (₹)</th>
                        <th class="text-right">Taxable Value (₹)</th>
                        <th class="text-center">GST %</th>
                        <th class="text-right">GST Amount (₹)</th>
                        <th class="text-right">Total (₹)</th>
                    </tr>
                </thead>
                <tbody>
                    ${(invoice.items || [])
                      .map((item, index) => {
                        // Calculate per-row values; support camelCase and snake_case (DB)
                        const rate = Number(item.rate) || 0;
                        const serviceFee =
                          Number(
                            item.professionalFee ?? item.professional_fee,
                          ) || 0;
                        const qty = Number(item.qty) || 0;

                        const serviceTypeName =
                          item.serviceType ||
                          item.service_type ||
                          item.itemName ||
                          item.item_name ||
                          "";
                        const isTourPackageWhollyOutside =
                          serviceTypeName.includes(
                            "Tour Package (wholly outside India)",
                          );
                        const isTourPackage =
                          serviceTypeName.includes("Tour Package") &&
                          !isTourPackageWhollyOutside;

                        const rawTaxable =
                          item.taxableValue ?? item.taxable_value;
                        const taxableValue =
                          rawTaxable !== undefined && rawTaxable !== null
                            ? Number(rawTaxable)
                            : isTourPackage
                              ? (rate + serviceFee) * qty
                              : isTourPackageWhollyOutside
                                ? rate * qty
                                : serviceFee * qty;

                        const gstPercentage =
                          (item.gstPercentage ?? item.gst_percentage) !==
                            undefined &&
                          (item.gstPercentage ?? item.gst_percentage) !== null
                            ? Number(item.gstPercentage ?? item.gst_percentage)
                            : isTourPackage
                              ? 5
                              : isTourPackageWhollyOutside
                                ? 0
                                : 18;
                        const rawGstAmt = item.gstAmount ?? item.gst_amount;
                        const gstAmount =
                          rawGstAmt !== undefined && rawGstAmt !== null
                            ? Number(rawGstAmt)
                            : taxableValue * (gstPercentage / 100);

                        // Row total: for Tour Package = taxable + GST; for wholly outside India = rate + serviceFee; for Others (Air Ticket etc) = rate + serviceFee + GST (Rate pass-through + taxable + GST)
                        const rowTotal = isTourPackageWhollyOutside
                          ? (rate + serviceFee) * qty
                          : isTourPackage
                            ? taxableValue + gstAmount
                            : rate * qty + taxableValue + gstAmount; // Others: Rate (pass-through) + Taxable (service fee) + GST

                        const itemName =
                          item.itemName ||
                          item.item_name ||
                          item.serviceType ||
                          item.service_type ||
                          "";
                        const itemDesc = item.description || "";
                        return `
                        <tr>
                            <td><div style="font-weight: 600;">${itemName}</div>${
                              itemDesc
                                ? `<div style="font-size: 9px; color: #64748b; margin-top: 2px;">${itemDesc}</div>`
                                : ""
                            }</td>
                            <td class="text-center">${item.sac || "9985"}</td>
                            <td class="text-center">${qty.toFixed(2)}</td>
                            <td class="text-right">₹${rate.toLocaleString(
                              "en-IN",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              },
                            )}</td>
                            <td class="text-right">₹${serviceFee.toLocaleString(
                              "en-IN",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              },
                            )}</td>
                            <td class="text-right">₹${taxableValue.toLocaleString(
                              "en-IN",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              },
                            )}</td>
                            <td class="text-center">${gstPercentage}%</td>
                            <td class="text-right">₹${gstAmount.toLocaleString(
                              "en-IN",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              },
                            )}</td>
                            <td class="text-right" style="font-weight: 600;">₹${rowTotal.toLocaleString(
                              "en-IN",
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              },
                            )}</td>
                        </tr>
                    `;
                      })
                      .join("")}
                </tbody>
                </table>
            </div>
        </section>

        <div class="totals-card">
            <div class="totals-with-qr-wrapper">
                ${
                  payUrl
                    ? `
                <div class="pay-qr-column">
                    <a href="${payUrl.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(
                          payUrl,
                        )}" alt="Pay with Razorpay" />
                    </a>
                    <div class="pay-here-title">Scan/Click to pay</div>
                </div>
                `
                    : ""
                }
            <div class="totals">
                <div class="totals-inner">
                ${(() => {
                  // CLONE EXACTLY what CRM calculates - use same calculation logic as CRM's calculateTotals function
                  let totalTaxableValue = 0;
                  let totalGstAmount = 0;
                  let subtotalBeforeGst = 0;

                  (invoice.items || []).forEach((item) => {
                    // Support both camelCase (frontend) and snake_case (DB) for item fields
                    const taxable =
                      (item.taxableValue ?? item.taxable_value) !== undefined &&
                      (item.taxableValue ?? item.taxable_value) !== null
                        ? Number(item.taxableValue ?? item.taxable_value)
                        : 0;
                    const gstAmt =
                      (item.gstAmount ?? item.gst_amount) !== undefined &&
                      (item.gstAmount ?? item.gst_amount) !== null
                        ? Number(item.gstAmount ?? item.gst_amount)
                        : 0;
                    const rate = Number(item.rate) || 0;
                    const serviceFee =
                      Number(item.professionalFee ?? item.professional_fee) ||
                      0;
                    const qty = Number(item.qty) || 0;

                    const serviceTypeName =
                      item.serviceType ||
                      item.service_type ||
                      item.itemName ||
                      item.item_name ||
                      "";
                    const isTourPackage =
                      serviceTypeName.includes("Tour Package") &&
                      !serviceTypeName.includes(
                        "Tour Package (wholly outside India)",
                      );
                    let itemBaseAmount = 0;
                    if (isTourPackage) {
                      itemBaseAmount = (rate + serviceFee) * qty;
                    } else {
                      itemBaseAmount = (rate + serviceFee) * qty;
                    }

                    totalTaxableValue += taxable;
                    totalGstAmount += gstAmt;
                    subtotalBeforeGst += itemBaseAmount;
                  });

                  // Sub total before GST = sum of (rate + service fee) per item (matches frontend)
                  const discountedSubtotal = Math.max(
                    0,
                    subtotalBeforeGst - discount,
                  );
                  // TCS base = taxable value + GST (for tour package); TCS not applied on pass-through rate
                  const tcsBase =
                    Math.max(0, totalTaxableValue - discount) + totalGstAmount;
                  let finalTcs = 0;
                  if (invoice.is_tcs_applied) {
                    const tcsPercent = Number(invoice.tcs_percentage) || 5;
                    finalTcs = tcsBase * (tcsPercent / 100);
                  }

                  const finalTotal =
                    discountedSubtotal + totalGstAmount + finalTcs;

                  // Round off: from DB (saved from CRM); display Total Amount as rounded value
                  const roundOff =
                    invoice.round_off != null ? Number(invoice.round_off) : 0;
                  const totalWithRoundOff =
                    invoice.total_amount != null
                      ? Number(invoice.total_amount)
                      : finalTotal + roundOff;

                  // Calculate Balance Due: Total Amount - Amount Paid
                  // Use actualAmountPaid from payments table if available, otherwise calculate from database
                  const amountPaid =
                    actualAmountPaid > 0
                      ? actualAmountPaid
                      : totalWithRoundOff -
                        (invoice.balance_due !== undefined &&
                        invoice.balance_due !== null
                          ? invoice.balance_due
                          : totalWithRoundOff);

                  // Balance Due = Total (with round off) - Amount Paid
                  const finalBalanceDue = Math.max(
                    0,
                    totalWithRoundOff - amountPaid,
                  );

                  return `
                <div class="totals-row">
                    <span>Sub Total</span>
                    <span>₹ ${discountedSubtotal.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</span>
                </div>
                ${
                  discount > 0
                    ? `
                <div class="totals-row" style="color: #dc2626;">
                    <span>Discount</span>
                    <span>- ₹ ${discount.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</span>
                </div>
                `
                    : ""
                }
                <div class="totals-row" style="font-weight: 600;">
                    <span>GST Amount</span>
                    <span>₹ ${totalGstAmount.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</span>
                </div>
                ${
                  finalTcs > 0 && invoice.is_tcs_applied
                    ? `
                <div class="totals-row">
                    <span>TCS ${
                      invoice.tcs_percentage
                        ? `(${invoice.tcs_percentage}%)`
                        : "(5%)"
                    }</span>
                    <span>₹ ${finalTcs.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 3,
                    })}</span>
                </div>
                `
                    : ""
                }
                ${
                  roundOff !== 0
                    ? `
                <div class="totals-row" style="${
                  roundOff >= 0 ? "color: #16a34a;" : "color: #dc2626;"
                }">
                    <span>Round off</span>
                    <span>₹ ${
                      roundOff >= 0 ? "+" : ""
                    }${roundOff.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</span>
                </div>
                `
                    : ""
                }
                <hr>
                <div class="totals-row bold">
                    <span>Total Amount</span>
                    <span>₹ ${totalWithRoundOff.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</span>
                </div>
                ${
                  amountPaid > 0
                    ? `
                <div class="totals-row" style="color: #dc2626;">
                    <span>Amount Paid</span>
                    <span>(-) ₹ ${amountPaid.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</span>
                </div>
                `
                    : ""
                }
                <div class="totals-row balance" style="color: #16a34a; font-weight: 600; margin-top: 4px;">
                    <span>Balance Due</span>
                    <span>₹ ${finalBalanceDue.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</span>
                </div>
                    `;
                })()}
                </div>
            </div>
            </div>
        </div>

        <footer>
            <div class="footer-grid">
                <div class="footer-card">
                    <h4>Bank Details</h4>
                    <p><span>Bank:</span> ICICI Bank</p>
                    <p><span>Account type:</span> Current Account</p>
                    <p><span>Account holder Name:</span> MADURA TRAVEL SERVICE PVT LTD</p>
                    <p><span>Branch:</span> EGMORE</p>
                    <p><span>Account no:</span> 603605017091</p>
                    <p><span>IFSC Code:</span> ICIC0006036</p>
                    <p><span>SWIFT Code:</span> ICICNBBCTS</p>
                </div>
                <div class="footer-card" style="text-align: right;">
                    <h4>For MADURA TRAVEL SERVICE (P) LTD.</h4>
                    ${
                      invoice.is_signed && branch.seal_signature_url
                        ? `<div class="signature-space" style="display:flex;justify-content:flex-end;align-items:center;margin:4px 25px 4px 0;">
                            <img src="${branch.seal_signature_url}" alt="Seal with Signature" style="max-height:48px;width:auto;object-fit:contain;" />
                           </div>`
                        : '<div class="signature-space" style="height:36px;margin-bottom:4px;"></div>'
                    }
                    <p class="signature-line">Authorised Signatory</p>
                </div>
            </div>
            <div class="terms">
                <h4>Terms &amp; Conditions</h4>
                <p class="terms-content">${chequeText
                  .replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")}</p>
            </div>
        </footer>
        <div class="digital-footer">${
          invoice.is_signed
            ? "This invoice has been digitally signed by MADURA TRAVEL SERVICE (P) LTD."
            : "This is a computer generated digital invoice, no signature required."
        }</div>
    </div>
</body>
</html>
  `;
}

/**
 * Generate invoice PDF as a Buffer (for download or sending via WhatsApp etc).
 * @param {number} invoiceId - Invoice ID
 * @returns {Promise<{ buffer: Buffer; invoiceNumber: string }>} - PDF buffer and invoice number for filename
 */
export async function generateInvoicePdfBuffer(invoiceId) {
  if (!invoiceId) {
    throw new Error("invoiceId is required");
  }

  // Fetch invoice with related data and payments
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select(
      `
        *,
        customer:customers(*),
        lead:leads(*)
        `,
    )
    .eq("id", invoiceId)
    .single();

  // Fetch paid payments for this invoice (only status = 'Paid')
  const { data: payments, error: paymentsError } = await supabase
    .from("payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .eq("status", "Paid");

  // Calculate actual amount paid from paid payments only
  const actualAmountPaid = payments
    ? payments.reduce((sum, p) => sum + (p.amount || 0), 0)
    : 0;

  if (invoiceError || !invoice) {
    throw new Error(invoiceError?.message || "Invoice not found");
  }

  const customer = invoice.customer;
  const lead = invoice.lead;

  if (!customer) {
    throw new Error("Customer details not found for this invoice");
  }

  // Fetch branch details
  let branch = null;
  if (lead && lead.branch_ids && lead.branch_ids.length > 0) {
    const { data: branchData } = await supabase
      .from("branches")
      .select("*")
      .eq("id", lead.branch_ids[0])
      .single();
    branch = branchData;
  }

  // Fallback to branch 1 if no branch found
  if (!branch) {
    const { data: branchData } = await supabase
      .from("branches")
      .select("*")
      .eq("id", 1)
      .single();
    branch = branchData;
  }

  if (!branch) {
    throw new Error("Branch details not found");
  }

  // HQ (branch id 1) Razorpay link as default for QR; use invoice-specific link if generated
  let hqRazorpayLink = branch.id === 1 ? branch.razorpay_link || "" : "";
  if (!hqRazorpayLink) {
    const { data: hqBranch } = await supabase
      .from("branches")
      .select("razorpay_link")
      .eq("id", 1)
      .single();
    hqRazorpayLink = hqBranch?.razorpay_link || "";
  }
  const payUrl =
    (invoice.razorpay_payment_link_url &&
      String(invoice.razorpay_payment_link_url).trim()) ||
    hqRazorpayLink ||
    "";

  pdfLog(`[Invoice PDF] Generating PDF for invoice ${invoice.invoice_number}`);

  // Generate HTML
  const html = generateInvoiceHtml({
    invoice,
    customer,
    branch,
    lead,
    actualAmountPaid, // Pass actual amount paid from payments
    payUrl, // Razorpay link for QR: invoice-specific or HQ default
  });

  // Launch Puppeteer: use system Chromium if available, else Puppeteer's bundled
  const executablePath = getChromiumPathForLaunch();
  if (executablePath) {
    const validation = validateChromiumPath(executablePath);
    if (validation.warnings.length > 0) {
      validation.warnings.forEach((warning) => {
        logger.warn(`[Invoice PDF Generator] ${warning}`);
      });
    }
  }

  // Retry logic for browser launch (handles intermittent snap cgroup issues)
  let browser;
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const launchOptions = {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          // Fix for xdg-settings and snap cgroup issues
          "--disable-features=VizDisplayCompositor",
          "--disable-software-rasterizer",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-client-side-phishing-detection",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-hang-monitor",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--disable-sync",
          "--disable-translate",
          "--metrics-recording-only",
          "--safebrowsing-disable-auto-update",
          "--enable-automation",
          "--password-store=basic",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-ipc-flooding-protection",
          "--disable-renderer-backgrounding",
          "--disable-features=TranslateUI",
          // Additional flags for Linux/server environments
          "--disable-background-downloads",
          "--disable-component-update",
          "--disable-domain-reliability",
          "--disable-features=AudioServiceOutOfProcess",
          "--disable-features=MediaRouter",
          "--disable-features=RendererCodeIntegrity",
          "--disable-features=UseChromeOSDirectVideoDecoder",
          "--disable-print-preview",
          "--disable-speech-api",
          "--hide-scrollbars",
          "--mute-audio",
          "--no-crash-upload",
          "--no-default-browser-check",
          "--no-pings",
          "--use-gl=swiftshader",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          // Additional flags to help with snap cgroup and D-Bus issues
          "--disable-background-timer-throttling",
          "--disable-features=TranslateUI,BlinkGenPropertyTrees",
          "--disable-ipc-flooding-protection",
          "--run-all-compositor-stages-before-draw",
          "--disable-partial-raster",
          "--disable-skia-runtime-opts",
          "--disable-system-font-check",
          // Disable D-Bus related features that cause issues in systemd services
          "--disable-features=AudioServiceOutOfProcess",
          "--disable-features=MediaRouter",
        ],
        // Additional options to help with snap/systemd issues
        ignoreDefaultArgs: ["--disable-extensions"],
        timeout: 30000, // 30 second timeout for launch
      };
      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }
      browser = await puppeteer.launch(launchOptions);
      break; // Success, exit retry loop
    } catch (launchError) {
      retryCount++;
      const errorMsg =
        launchError?.message || launchError?.toString() || "Unknown error";

      // Check if it's a snap cgroup or xdg-settings error
      const isSnapError =
        errorMsg.includes("snap cgroup") ||
        errorMsg.includes("xdg-settings") ||
        errorMsg.includes("Failed to launch") ||
        errorMsg.includes("Code: 1");

      if (retryCount < maxRetries && isSnapError) {
        const waitTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000); // Exponential backoff, max 5s
        logger.warn(
          `[Invoice PDF Generator] Browser launch failed (attempt ${retryCount}/${maxRetries}): ${errorMsg}. Retrying in ${waitTime}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      } else {
        // Max retries reached or non-retryable error
        logger.error(
          `[Invoice PDF Generator] Failed to launch browser after ${retryCount} attempts: ${errorMsg}`,
        );
        throw new Error(
          `Failed to launch Chromium browser: ${errorMsg}. ` +
            `This may be due to snap cgroup restrictions. ` +
            `Consider installing Chromium via apt: sudo apt-get install chromium-browser`,
        );
      }
    }
  }

  const page = await browser.newPage();

  // Set viewport for consistent rendering
  await page.setViewport({ width: 1200, height: 800 });

  // Set content and wait for it to load
  await page.setContent(html, {
    waitUntil: ["networkidle0", "domcontentloaded"],
    timeout: 30000,
  });

  // Wait a bit more to ensure all resources are loaded
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Generate PDF
  const pdf = await page.pdf({
    printBackground: true,
    format: "A4",
    margin: {
      top: "0mm",
      right: "0mm",
      bottom: "0mm",
      left: "0mm",
    },
  });

  await browser.close();

  pdfLog(`[Invoice PDF] PDF generated, size: ${pdf.length} bytes`);
  logger.info("[Invoice PDF] PDF ready", {
    size: pdf.length,
    invoiceNumber: invoice?.invoice_number ?? null,
  });

  // Validate PDF buffer
  if (!pdf || pdf.length === 0) {
    throw new Error("Generated PDF is empty");
  }

  return {
    buffer: Buffer.from(pdf),
    invoiceNumber: invoice.invoice_number,
  };
}

// Express handler for /api/invoice/generate-pdf
export async function generateInvoicePdf(req, res) {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) {
      return res.status(400).json({ message: "invoiceId is required" });
    }
    const { buffer, invoiceNumber } = await generateInvoicePdfBuffer(invoiceId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Invoice_${invoiceNumber}.pdf"`,
    );
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (error) {
    console.error("[Invoice PDF] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        message: error.message || "An internal server error occurred",
      });
    }
  }
}

import pdfParse from "pdf-parse";
import ExcelJS from "exceljs";
import fetch from "node-fetch";

/**
 * Extract text content from a PDF file buffer
 * @param {Buffer} fileBuffer - The PDF file buffer
 * @returns {Promise<string>} - Extracted text content
 */
export async function extractTextFromPDF(fileBuffer) {
  try {
    const data = await pdfParse(fileBuffer);
    return data.text || "";
  } catch (error) {
    console.error("[File Extractor] PDF extraction error:", error.message);
    throw new Error(`Failed to extract text from PDF: ${error.message}`);
  }
}

/**
 * Extract text content from an Excel file buffer
 * @param {Buffer} fileBuffer - The Excel file buffer
 * @returns {Promise<string>} - Extracted text content
 */
export async function extractTextFromExcel(fileBuffer) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    
    let extractedText = "";

    // Process each worksheet
    workbook.eachSheet((worksheet, sheetId) => {
      const sheetName = worksheet.name;
      extractedText += `\n--- Sheet: ${sheetName} ---\n`;
      
      // Iterate through all rows
      worksheet.eachRow((row, rowNumber) => {
        const rowValues = [];
        row.eachCell((cell, colNumber) => {
          // Get cell value, handling different cell types
          let cellValue = "";
          if (cell.value !== null && cell.value !== undefined) {
            if (typeof cell.value === "object" && cell.value.text) {
              // Rich text
              cellValue = cell.value.text;
            } else if (typeof cell.value === "object" && cell.value.richText) {
              // Rich text array
              cellValue = cell.value.richText.map(rt => rt.text).join("");
            } else {
              cellValue = String(cell.value);
            }
          }
          if (cellValue.trim()) {
            rowValues.push(cellValue.trim());
          }
        });
        
        if (rowValues.length > 0) {
          extractedText += `Row ${rowNumber}: ${rowValues.join(" | ")}\n`;
        }
      });
    });

    return extractedText.trim();
  } catch (error) {
    console.error("[File Extractor] Excel extraction error:", error.message);
    throw new Error(`Failed to extract text from Excel: ${error.message}`);
  }
}

/**
 * Download a file from a URL and return its buffer
 * @param {string} url - The file URL
 * @returns {Promise<Buffer>} - File buffer
 */
export async function downloadFile(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("[File Extractor] Download error:", error.message);
    throw new Error(`Failed to download file from URL: ${error.message}`);
  }
}

/**
 * Extract text from a file based on its type
 * @param {Buffer} fileBuffer - The file buffer
 * @param {string} fileType - MIME type (e.g., 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
 * @returns {Promise<string>} - Extracted text content
 */
export async function extractTextFromFile(fileBuffer, fileType) {
  if (fileType === "application/pdf" || fileType === "application/x-pdf") {
    return await extractTextFromPDF(fileBuffer);
  } else if (
    fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    fileType === "application/vnd.ms-excel" ||
    fileType === "application/excel" ||
    fileType === "application/x-excel" ||
    fileType === "application/x-msexcel"
  ) {
    return await extractTextFromExcel(fileBuffer);
  } else {
    throw new Error(`Unsupported file type: ${fileType}`);
  }
}

/**
 * Extract text from a file URL (downloads first, then extracts)
 * @param {string} fileUrl - The file URL
 * @param {string} fileType - MIME type or file extension
 * @returns {Promise<string>} - Extracted text content
 */
export async function extractTextFromFileURL(fileUrl, fileType) {
  try {
    // Download the file
    const fileBuffer = await downloadFile(fileUrl);
    
    // Determine MIME type if not provided
    let mimeType = fileType;
    if (!mimeType || !mimeType.includes("/")) {
      // Try to determine from URL extension
      const urlLower = fileUrl.toLowerCase();
      if (urlLower.endsWith(".pdf")) {
        mimeType = "application/pdf";
      } else if (urlLower.endsWith(".xlsx")) {
        mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      } else if (urlLower.endsWith(".xls")) {
        mimeType = "application/vnd.ms-excel";
      }
    }
    
    // Extract text
    return await extractTextFromFile(fileBuffer, mimeType);
  } catch (error) {
    console.error("[File Extractor] Extraction from URL error:", error.message);
    throw error;
  }
}


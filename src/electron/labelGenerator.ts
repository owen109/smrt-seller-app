// @ts-nocheck
import bwipjs from 'bwip-js';
import { jsPDF } from 'jspdf';
import path from 'path';
import { app } from 'electron';
import { promises as fs } from 'fs';

// Standard label sizes in mm (based on Amazon's specifications)
export const LABEL_SIZES = {
    STANDARD: { width: 66.7, height: 25.4 },    // 2.625" x 1" (Amazon standard)
    SMALL: { width: 50.8, height: 25.4 },       // 2" x 1" (minimum)
    LARGE: { width: 76.2, height: 50.8 }        // 3" x 2" (maximum)
} as const;

export type LabelSize = keyof typeof LABEL_SIZES;

export interface LabelData {
    fnsku: string;
    sku: string;
    asin: string;
    title?: string;
    condition?: string;
    labelSize?: LabelSize;
}

/**
 * Generates a PDF label with FNSKU barcode and product information
 */
export async function generateLabel({
    fnsku,
    sku,
    asin,
    title = '',
    condition = '',
    labelSize = 'STANDARD'
}: LabelData): Promise<string> {
    try {
        console.log('\nGenerating FNSKU label for ', fnsku);
        
        const dimensions = LABEL_SIZES[labelSize];

        // Generate barcode buffer with improved settings
        const barcodeBuffer = await new Promise<Buffer>((resolve, reject) => {
            bwipjs.toBuffer({
                bcid: 'code128',
                text: fnsku,
                scale: 4,                     // Increased scale for better clarity
                height: 10,                   // Standard height
                includetext: true,
                textxalign: 'center',
                textsize: 7,                  // Increased text size
                width: dimensions.width * 0.8  // Adjusted width
            }, function (err, png) {
                if (err) reject(err);
                else resolve(png);
            });
        });

        // Create PDF with landscape orientation (wider than tall)
        const doc = new jsPDF({
            orientation: 'landscape',
            unit: 'mm',
            format: [dimensions.height, dimensions.width]  // Swapped for landscape
        });

        // Calculate positions for centered elements
        const barcodeWidth = dimensions.width * 0.8;
        const barcodeHeight = dimensions.height * 0.5;
        const barcodeX = (dimensions.width - barcodeWidth) / 2;  // Center horizontally
        const barcodeY = dimensions.height * 0.1;
        const textMargin = barcodeX;  // Use same margin as barcode

        // Add barcode centered
        doc.addImage(
            barcodeBuffer,
            'PNG',
            barcodeX,
            barcodeY,
            barcodeWidth,
            barcodeHeight
        );

        // Set up text properties
        doc.setFontSize(5.5);  // Reduced from 7 to 5.5
        doc.setFont('Helvetica', 'normal');  // Changed to Helvetica for better clarity
        
        // Calculate text positions with proper spacing
        const textStartY = dimensions.height * 0.70;  // Increased from 0.65 to 0.70 to move text down
        const lineHeight = 2.2; // Reduced line height for less vertical spacing

        // Function to add text with proper spacing
        function addSpacedText(text: string, y: number) {
            const chars = text.split('');
            const charSpacing = 0.35; // Adjusted character spacing
            let currentX = textMargin;
            
            chars.forEach((char) => {
                doc.text(char, currentX, y);
                currentX += doc.getTextWidth(char) + charSpacing;
            });
        }

        // Add text lines with proper spacing
        if (title) {
            addSpacedText(`Title: ${title.substring(0, 50)}${title.length > 50 ? '...' : ''}`, textStartY);
            addSpacedText(`ASIN: ${asin}`, textStartY + lineHeight);
            addSpacedText(`SKU: ${sku}`, textStartY + (lineHeight * 2));
            addSpacedText(`FNSKU: ${fnsku}`, textStartY + (lineHeight * 3));
            if (condition) {
                addSpacedText(`Condition: ${condition}`, textStartY + (lineHeight * 4));
            }
        } else {
            addSpacedText(`ASIN: ${asin}`, textStartY);
            addSpacedText(`SKU: ${sku}`, textStartY + lineHeight);
            addSpacedText(`FNSKU: ${fnsku}`, textStartY + (lineHeight * 2));
            if (condition) {
                addSpacedText(`Condition: ${condition}`, textStartY + (lineHeight * 3));
            }
        }

        // Save the PDF to the app's temp directory
        const tempDir = path.join(app.getPath('temp'), 'smrt-seller-labels');
        const filename = path.join(tempDir, `FNSKU_Label_${fnsku}.pdf`);
        
        // Ensure temp directory exists
        await fs.mkdir(tempDir, { recursive: true });
        
        // Save the PDF
        doc.save(filename);

        console.log(`Label generated successfully: ${filename}`);
        return filename;

    } catch (error) {
        console.error('Error generating label:', error);
        throw error;
    }
} 
// @ts-nocheck
import bwipjs from 'bwip-js';
import { jsPDF } from 'jspdf';
import path from 'path';
import { app } from 'electron';
import { promises as fs } from 'fs';

// Standard label sizes in mm (based on Amazon's specifications)
export const LABEL_SIZES = {
    STANDARD: { width: 66.7, height: 25.4 },    // 2.625" x 1" (Amazon standard)
    SMALL: { width: 54.0, height: 25.4 },       // 2.125" x 1" (minimum)
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
                scale: 5,                    // Increased scale further for even higher resolution
                height: 10,                  // Increased height for better scanning
                includetext: true,
                textxalign: 'center',
                textsize: 7,                 // Slightly larger text for better readability
                width: dimensions.width * 0.85,  // Increased width to use more space
                backgroundcolor: 'ffffff',    // White background
                padding: 0,                   // No padding
                resolution: 600,              // Doubled DPI for much higher quality
                sizelimit: 0,                // Remove size limit
                guardwhitespace: true,       // Add white space guards
                inkspread: 0,                // Compensate for ink spread
                textyoffset: 2               // Adjust text position
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

        // Calculate positions for centered elements with reduced margins
        const margin = dimensions.width * 0.08;  // Reduced margin to 8% on sides
        const barcodeWidth = dimensions.width * 0.85;  // Increased to 85% of width
        const barcodeHeight = dimensions.height * 0.45;  // Kept same height
        const barcodeX = (dimensions.width - barcodeWidth) / 2;  // Center horizontally
        const barcodeY = dimensions.height * 0.15;  // Moved down slightly
        const textMargin = margin + 2;  // Add 2mm to text margin for better spacing

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
        doc.setFontSize(5);  // Reduced font size for better fit
        doc.setFont('Helvetica', 'normal');
        
        // Calculate text positions with proper spacing
        const textStartY = dimensions.height * 0.75;  // Moved up slightly
        const lineHeight = 2;  // Reduced line height

        // Function to add text with proper spacing
        function addSpacedText(text: string, y: number) {
            const chars = text.split('');
            const charSpacing = 0.3;  // Reduced character spacing
            let currentX = textMargin;
            
            chars.forEach((char) => {
                doc.text(char, currentX, y);
                currentX += doc.getTextWidth(char) + charSpacing;
            });
        }

        // Add text lines with proper spacing (removed redundant FNSKU line)
        if (title) {
            addSpacedText(`Title: ${title.substring(0, 45)}${title.length > 45 ? '...' : ''}`, textStartY);
            addSpacedText(`ASIN: ${asin}`, textStartY + lineHeight);
            addSpacedText(`SKU: ${sku}`, textStartY + (lineHeight * 2));
            if (condition) {
                addSpacedText(`Condition: ${condition}`, textStartY + (lineHeight * 3));
            }
        } else {
            addSpacedText(`ASIN: ${asin}`, textStartY);
            addSpacedText(`SKU: ${sku}`, textStartY + lineHeight);
            if (condition) {
                addSpacedText(`Condition: ${condition}`, textStartY + (lineHeight * 2));
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
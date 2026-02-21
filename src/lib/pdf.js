import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { query } from './database.js';

/**
 * Generate PDF invoice
 * @param {Object} invoice - Invoice data with items
 * @param {Object} tenantInfo - Tenant/business information
 * @returns {Promise<Buffer>} PDF buffer
 */
export async function generateInvoicePDF(invoice, tenantInfo) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        size: 'A4',
        margin: 50,
        info: {
          Title: `Invoice ${invoice.invoice_number}`,
          Author: tenantInfo.name || 'Beauty Center',
          Subject: 'Invoice',
        }
      });

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });
      doc.on('error', reject);

      // ── Colors ──
      const primaryColor = '#1e293b';
      const secondaryColor = '#64748b';
      const accentColor = '#f2421b';

      // ── Header: Logo + Title ──
      doc.fontSize(24).font('Helvetica-Bold').fillColor(primaryColor);
      
      // Logo (if available)
      if (tenantInfo.logo_url) {
        try {
          // For now, we'll add a placeholder. In production, you'd fetch and embed the image
          // doc.image(tenantInfo.logo_url, 50, 50, { width: 80, height: 80 });
        } catch (e) {
          // If logo fails, continue without it
        }
      }

      // Invoice title
      doc.text('INVOICE', 50, 50, { align: 'right' });
      doc.fontSize(12).font('Helvetica').fillColor(secondaryColor);
      doc.text(`Invoice #${invoice.invoice_number}`, 50, 80, { align: 'right' });

      // ── Business Info ──
      doc.fontSize(14).font('Helvetica-Bold').fillColor(primaryColor);
      doc.text(tenantInfo.name || tenantInfo.company_name || 'Beauty Center', 50, 120);
      
      doc.fontSize(10).font('Helvetica').fillColor(secondaryColor);
      let yPos = 145;
      if (tenantInfo.address) {
        doc.text(tenantInfo.address, 50, yPos);
        yPos += 15;
      }
      if (tenantInfo.city || tenantInfo.country) {
        doc.text([tenantInfo.city, tenantInfo.country].filter(Boolean).join(', '), 50, yPos);
        yPos += 15;
      }
      if (tenantInfo.email) {
        doc.text(`Email: ${tenantInfo.email}`, 50, yPos);
        yPos += 15;
      }
      if (tenantInfo.phone) {
        doc.text(`Phone: ${tenantInfo.phone}`, 50, yPos);
        yPos += 15;
      }

      // ── Invoice Details (Right Side) ──
      const rightX = 350;
      doc.fontSize(10).font('Helvetica').fillColor(secondaryColor);
      doc.text('Issue Date:', rightX, 145);
      doc.font('Helvetica-Bold').fillColor(primaryColor);
      doc.text(new Date(invoice.created_at).toLocaleDateString('en-GB', { 
        day: '2-digit', month: 'short', year: 'numeric' 
      }), rightX, 160);

      doc.font('Helvetica').fillColor(secondaryColor);
      doc.text('Due Date:', rightX, 180);
      doc.font('Helvetica-Bold').fillColor(primaryColor);
      if (invoice.due_date) {
        doc.text(new Date(invoice.due_date).toLocaleDateString('en-GB', { 
          day: '2-digit', month: 'short', year: 'numeric' 
        }), rightX, 195);
      } else {
        doc.text('N/A', rightX, 195);
      }

      doc.font('Helvetica').fillColor(secondaryColor);
      doc.text('Status:', rightX, 215);
      doc.font('Helvetica-Bold');
      const statusColors = {
        paid: '#10b981',
        draft: '#6b7280',
        sent: '#3b82f6',
        overdue: '#ef4444',
        partially_paid: '#f59e0b',
        void: '#9ca3af'
      };
      doc.fillColor(statusColors[invoice.status] || primaryColor);
      doc.text(invoice.status.toUpperCase().replace('_', ' '), rightX, 230);

      // ── Client Info ──
      const clientY = yPos + 30;
      doc.fontSize(12).font('Helvetica-Bold').fillColor(primaryColor);
      doc.text('Bill To:', 50, clientY);
      doc.fontSize(10).font('Helvetica').fillColor(secondaryColor);
      let clientYPos = clientY + 20;
      const clientName = `${invoice.customer_first_name || ''} ${invoice.customer_last_name || ''}`.trim() || 'Client';
      doc.text(clientName, 50, clientYPos);
      clientYPos += 15;
      if (invoice.customer_email) {
        doc.text(`Email: ${invoice.customer_email}`, 50, clientYPos);
        clientYPos += 15;
      }
      if (invoice.customer_phone) {
        doc.text(`Phone: ${invoice.customer_phone}`, 50, clientYPos);
        clientYPos += 15;
      }

      // ── Items Table ──
      const tableTop = clientYPos + 30;
      doc.fontSize(10).font('Helvetica-Bold').fillColor(primaryColor);
      
      // Table header background
      doc.rect(50, tableTop - 10, 500, 25).fillAndStroke('#f8fafc', primaryColor);
      
      // Table headers
      doc.text('Description', 60, tableTop);
      doc.text('Qty', 350, tableTop, { width: 50, align: 'center' });
      doc.text('Rate', 410, tableTop, { width: 80, align: 'right' });
      doc.text('Total', 500, tableTop, { width: 50, align: 'right' });

      // Table rows
      let currentY = tableTop + 30;
      const currencySymbol = invoice.currency === 'AED' ? 'د.إ' : (invoice.currency || 'AED');
      
      doc.font('Helvetica').fillColor(secondaryColor);
      invoice.items.forEach((item, index) => {
        if (currentY > 700) {
          // Add new page if needed
          doc.addPage();
          currentY = 50;
        }

        const itemName = item.name || item.description || 'Item';
        const quantity = item.quantity || 1;
        const unitPrice = parseFloat(item.unit_price || 0);
        const discount = parseFloat(item.discount || 0);
        const itemTotal = parseFloat(item.total || (quantity * unitPrice - discount));

        // Item row
        doc.text(itemName, 60, currentY, { width: 280 });
        doc.text(String(quantity), 350, currentY, { width: 50, align: 'center' });
        doc.text(`${currencySymbol} ${unitPrice.toFixed(2)}`, 410, currentY, { width: 80, align: 'right' });
        doc.text(`${currencySymbol} ${itemTotal.toFixed(2)}`, 500, currentY, { width: 50, align: 'right' });

        // Discount note if applicable
        if (discount > 0) {
          doc.fontSize(8).fillColor('#f59e0b');
          doc.text(`(-${currencySymbol} ${discount.toFixed(2)} discount)`, 60, currentY + 12);
          doc.fontSize(10).fillColor(secondaryColor);
        }

        currentY += 25;
      });

      // ── Totals Section ──
      const totalsY = currentY + 20;
      const totalsX = 350;
      
      doc.fontSize(10).font('Helvetica').fillColor(secondaryColor);
      
      // Subtotal
      doc.text('Subtotal:', totalsX, totalsY, { width: 100, align: 'right' });
      doc.font('Helvetica-Bold').fillColor(primaryColor);
      doc.text(`${currencySymbol} ${parseFloat(invoice.subtotal || 0).toFixed(2)}`, 500, totalsY, { width: 50, align: 'right' });
      
      let nextY = totalsY + 20;
      
      // Discount
      if (parseFloat(invoice.discount_amount || 0) > 0) {
        doc.font('Helvetica').fillColor(secondaryColor);
        doc.text('Discount:', totalsX, nextY, { width: 100, align: 'right' });
        doc.font('Helvetica-Bold').fillColor('#f59e0b');
        doc.text(`-${currencySymbol} ${parseFloat(invoice.discount_amount).toFixed(2)}`, 500, nextY, { width: 50, align: 'right' });
        nextY += 20;
      }
      
      // Tax
      if (parseFloat(invoice.tax_amount || 0) > 0) {
        doc.font('Helvetica').fillColor(secondaryColor);
        doc.text(`Tax (${parseFloat(invoice.tax_rate || 0).toFixed(1)}%):`, totalsX, nextY, { width: 100, align: 'right' });
        doc.font('Helvetica-Bold').fillColor(primaryColor);
        doc.text(`${currencySymbol} ${parseFloat(invoice.tax_amount).toFixed(2)}`, 500, nextY, { width: 50, align: 'right' });
        nextY += 20;
      }
      
      // Grand Total
      doc.fontSize(14).font('Helvetica-Bold').fillColor(accentColor);
      doc.rect(totalsX - 10, nextY - 5, 200, 30).stroke(accentColor);
      doc.text('Grand Total:', totalsX, nextY, { width: 100, align: 'right' });
      doc.text(`${currencySymbol} ${parseFloat(invoice.total || 0).toFixed(2)}`, 500, nextY, { width: 50, align: 'right' });
      
      // Balance Due
      const balanceDue = parseFloat(invoice.total || 0) - parseFloat(invoice.amount_paid || 0);
      if (balanceDue > 0) {
        nextY += 30;
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#ef4444');
        doc.text('Balance Due:', totalsX, nextY, { width: 100, align: 'right' });
        doc.text(`${currencySymbol} ${balanceDue.toFixed(2)}`, 500, nextY, { width: 50, align: 'right' });
      }

      // ── Payment Info ──
      if (invoice.payment_method && parseFloat(invoice.amount_paid || 0) > 0) {
        nextY += 30;
        doc.fontSize(10).font('Helvetica').fillColor(secondaryColor);
        doc.text('Payment Information:', 50, nextY);
        nextY += 15;
        doc.text(`Method: ${(invoice.payment_method || '').replace('_', ' ').toUpperCase()}`, 50, nextY);
        nextY += 15;
        doc.text(`Amount Paid: ${currencySymbol} ${parseFloat(invoice.amount_paid).toFixed(2)}`, 50, nextY);
        if (invoice.paid_at) {
          nextY += 15;
          doc.text(`Paid On: ${new Date(invoice.paid_at).toLocaleDateString('en-GB', { 
            day: '2-digit', month: 'short', year: 'numeric' 
          })}`, 50, nextY);
        }
      }

      // ── QR Code ──
      try {
        const qrData = JSON.stringify({
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          total: invoice.total,
          currency: invoice.currency,
          status: invoice.status
        });
        const qrCodeDataURL = await QRCode.toDataURL(qrData, { 
          width: 100,
          margin: 1,
          color: { dark: '#000000', light: '#FFFFFF' }
        });
        
        // Convert data URL to buffer and embed
        const base64Data = qrCodeDataURL.replace(/^data:image\/png;base64,/, '');
        const qrBuffer = Buffer.from(base64Data, 'base64');
        
        doc.image(qrBuffer, 450, nextY + 20, { width: 80, height: 80 });
        doc.fontSize(8).font('Helvetica').fillColor(secondaryColor);
        doc.text('Scan to verify', 450, nextY + 105, { width: 80, align: 'center' });
      } catch (qrError) {
        console.error('QR code generation error:', qrError);
        // Continue without QR code
      }

      // ── Notes ──
      if (invoice.notes) {
        const notesY = Math.max(nextY + 120, 650);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(primaryColor);
        doc.text('Notes:', 50, notesY);
        doc.font('Helvetica').fillColor(secondaryColor);
        doc.text(invoice.notes, 50, notesY + 15, { width: 450 });
      }

      // ── Terms & Conditions ──
      const termsY = 750;
      doc.fontSize(8).font('Helvetica').fillColor('#94a3b8');
      doc.text('Terms & Conditions:', 50, termsY);
      doc.text('Payment is due within the specified date. Late payments may incur additional charges.', 50, termsY + 12, { width: 500 });
      doc.text('This invoice was created electronically and is valid without signature.', 50, termsY + 24, { width: 500 });

      // ── Footer ──
      doc.fontSize(8).font('Helvetica').fillColor('#cbd5e1');
      doc.text(`Generated on ${new Date().toLocaleDateString('en-GB', { 
        day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' 
      })}`, 50, 800, { align: 'center', width: 500 });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Get tenant information for PDF
 * @param {number} tenantId - Tenant ID
 * @returns {Promise<Object>} Tenant information
 */
export async function getTenantInfo(tenantId) {
  try {
    const [tenant] = await query(
      `SELECT name, logo_url, address, city, country, email, phone, settings 
       FROM tenants WHERE id = ?`,
      [tenantId]
    );
    
    if (!tenant) {
      return {
        name: 'Beauty Center',
        company_name: 'Beauty Center'
      };
    }

    // Parse settings if available
    let settings = {};
    if (tenant.settings) {
      try {
        settings = typeof tenant.settings === 'string' 
          ? JSON.parse(tenant.settings) 
          : tenant.settings;
      } catch (e) {
        // Ignore parse errors
      }
    }

    return {
      name: tenant.name,
      company_name: tenant.name || settings.company_name || 'Beauty Center',
      logo_url: tenant.logo_url,
      address: tenant.address,
      city: tenant.city,
      country: tenant.country,
      email: tenant.email || settings.email,
      phone: tenant.phone || settings.phone,
    };
  } catch (error) {
    console.error('Error fetching tenant info:', error);
    return {
      name: 'Beauty Center',
      company_name: 'Beauty Center'
    };
  }
}

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { config } from './config.js';
import { initDatabase } from './lib/database.js';
import { processPendingReminders } from './lib/reminders.js';
import { runBillingCron } from './jobs/billing-cron.js';

// Import middleware
import { tenantMiddleware } from './middleware/tenant.js';

// Import routes
import authRoutes from './routes/auth.js';
import tenantsRoutes from './routes/tenants.js';
import staffRoutes from './routes/staff.js';
import staffPublicRoutes from './routes/staff-public.js';
import accountsRoutes from './routes/accounts.js';
import contactsRoutes from './routes/contacts.js';
import leadsRoutes from './routes/leads.js';
import dealsRoutes from './routes/deals.js';
import activitiesRoutes from './routes/activities.js';
import pipelinesRoutes from './routes/pipelines.js';
import statsRoutes from './routes/stats.js';
import notesRoutes from './routes/notes.js';
import tagsRoutes from './routes/tags.js';
import reportsRoutes from './routes/reports.js';
import productsRoutes from './routes/products.js';
import quotesRoutes from './routes/quotes.js';
import branchesRoutes from './routes/branches.js';
import customFieldsRoutes from './routes/custom-fields.js';
import workflowsRoutes from './routes/workflows.js';
import campaignsRoutes from './routes/campaigns.js';
import documentsRoutes from './routes/documents.js';
import auditLogsRoutes from './routes/audit-logs.js';
import emailTemplatesRoutes from './routes/email-templates.js';
import inboxRoutes from './routes/inbox.js';
import audiencesRoutes from './routes/audiences.js';
import integrationsRoutes from './routes/integrations.js';
import aiChatRoutes from './routes/ai-chat.js';
import superAdminRoutes from './routes/super-admin.js';
import appointmentsRoutes from './routes/appointments.js';
import loyaltyRoutes from './routes/loyalty.js';
import staffScheduleRoutes from './routes/staff-schedule.js';
import serviceCategoriesRoutes from './routes/service-categories.js';
import resourcesRoutes from './routes/resources.js';
import uploadsRoutes from './routes/uploads.js';
import invoicesRoutes from './routes/invoices.js';
import giftCardsRoutes from './routes/gift-cards.js';
import waitlistsRoutes from './routes/waitlists.js';
import packagesRoutes from './routes/packages.js';
import membershipsRoutes from './routes/memberships.js';
import promotionsRoutes from './routes/promotions.js';
import reviewsRoutes from './routes/reviews.js';
import posRoutes from './routes/pos.js';
import consultationFormsRoutes from './routes/consultation-forms.js';
import groupBookingsRoutes from './routes/group-bookings.js';
import patchTestsRoutes from './routes/patch-tests.js';
import clientProfilesRoutes from './routes/client-profiles.js';
import inventoryRoutes from './routes/inventory.js';
import notificationsRoutes from './routes/notifications.js';
import publicBookingRoutes from './routes/public-booking.js';
import rolesRoutes from './routes/roles.js';
import appConnectRoutes from './routes/app-connect.js';
import barcodeRoutes from './routes/barcode.js';

const app = express();

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests from any localhost port and subdomains
    const allowedPatterns = [
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      /^https?:\/\/.*\.trasealla\.com$/,
      /^https?:\/\/trasealla\.com$/
    ];
    
    if (!origin || allowedPatterns.some(pattern => pattern.test(origin))) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all in development
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Trasealla CRM API is running', 
    version: '1.0.0',
    environment: config.env,
    timestamp: new Date().toISOString()
  });
});

// Public routes (no tenant context required)
app.use('/api/auth', authRoutes);
app.use('/api/tenants', tenantsRoutes);
app.use('/api/public/booking', publicBookingRoutes);
// Public staff routes (set password - no tenant required)
app.use('/api/staff/set-password', staffPublicRoutes);

// Super Admin routes (Trasealla platform management)
app.use('/api/super-admin', superAdminRoutes);

// Apply tenant middleware to all other routes
app.use(tenantMiddleware);

// CRM Core routes (require tenant context)
app.use('/api/staff', staffRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/deals', dealsRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/pipelines', pipelinesRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/quotes', quotesRoutes);
app.use('/api/branches', branchesRoutes);
app.use('/api/custom-fields', customFieldsRoutes);
app.use('/api/workflows', workflowsRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/audit-logs', auditLogsRoutes);
app.use('/api/email-templates', emailTemplatesRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/audiences', audiencesRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/ai', aiChatRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/loyalty', loyaltyRoutes);
app.use('/api/staff-schedule', staffScheduleRoutes);
app.use('/api/service-categories', serviceCategoriesRoutes);
app.use('/api/resources', resourcesRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/gift-cards', giftCardsRoutes);
app.use('/api/waitlists', waitlistsRoutes);
app.use('/api/packages', packagesRoutes);
app.use('/api/memberships', membershipsRoutes);
app.use('/api/promotions', promotionsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/consultation-forms', consultationFormsRoutes);
app.use('/api/group-bookings', groupBookingsRoutes);
app.use('/api/patch-tests', patchTestsRoutes);
app.use('/api/client-profiles', clientProfilesRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/booking-settings', publicBookingRoutes);
app.use('/api/app-connect', appConnectRoutes);
app.use('/api/barcodes', barcodeRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Start server
async function start() {
  try {
    await initDatabase();
    
    // Start reminder cron job (runs every minute)
    cron.schedule('* * * * *', async () => {
      try {
        const result = await processPendingReminders();
        if (result.processed > 0) {
          console.log(`📅 Reminders: ${result.sent} sent, ${result.failed} failed`);
        }
      } catch (error) {
        console.error('❌ Reminder cron job error:', error);
      }
    });
    console.log('✅ Reminder cron job started (runs every minute)');
    
    // Billing cron job — runs daily at 00:05 AM
    cron.schedule('5 0 * * *', async () => {
      try {
        await runBillingCron();
      } catch (error) {
        console.error('❌ Billing cron job error:', error);
      }
    });
    console.log('✅ Billing cron job started (runs daily at 00:05)');
    
    app.listen(config.port, () => {
      console.log(`
╔════════════════════════════════════════════════════════════════╗
║               TRASEALLA CRM BACKEND SERVER                     ║
╠════════════════════════════════════════════════════════════════╣
║  🚀 Server:    http://localhost:${config.port}                        ║
║  📊 Health:    http://localhost:${config.port}/api/health             ║
║  🏢 Tenants:   http://localhost:${config.port}/api/tenants            ║
╠════════════════════════════════════════════════════════════════╣
║  🔑 SUPER ADMIN (Platform):                                    ║
║     trasealla_admin / Trasealla@2025!                          ║
╠════════════════════════════════════════════════════════════════╣
║  DEMO TENANT USERS (Role-Based):                               ║
║  👑 admin          / admin123       (Admin / Owner)             ║
║  📋 manager_demo   / Manager123    (Manager)                   ║
║  💁 reception_demo / Reception123  (Receptionist)              ║
║  💇 stylist_demo   / Stylist123    (Stylist)                   ║
║  👤 demo           / demo123       (Staff)                     ║
╚════════════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

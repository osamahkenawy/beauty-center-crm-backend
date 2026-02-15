import express from 'express';
import OpenAI from 'openai';
import { query } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Lazy initialize OpenAI client - only when API key is available
let openaiClient = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.log('[AI Chat] OPENAI_API_KEY not found in environment variables');
    return null;
  }
  if (!openaiClient) {
    console.log('[AI Chat] Initializing OpenAI client with API key');
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

// System prompt for CRM context
const getSystemPrompt = (crmData) => {
  return `You are an AI assistant for Trasealla CRM, a customer relationship management system. You help users with their sales, leads, deals, contacts, and activities.

IMPORTANT RULES:
1. Be helpful, concise, and professional
2. Always use the CRM data provided to give accurate answers
3. If asked about data not provided, say you don't have access to that specific information
4. Format numbers nicely (use commas, currency symbols)
5. Suggest actions when appropriate (e.g., "Would you like to create a new lead?")
6. Keep responses brief but informative
7. Use emojis sparingly to make responses friendly

CURRENT CRM DATA:
${JSON.stringify(crmData, null, 2)}

When referencing amounts, use AED currency format.
When referencing dates, use readable format.
`;
};

// Fetch CRM data for context
async function getCRMContext(tenantId, userId) {
  const tenantFilter = tenantId ? ' AND tenant_id = ?' : '';
  const tenantParams = tenantId ? [tenantId] : [];

  try {
    // Leads summary
    const [leadsTotal] = await query(`SELECT COUNT(*) as count FROM leads WHERE 1=1${tenantFilter}`, tenantParams);
    const [leadsNew] = await query(`SELECT COUNT(*) as count FROM leads WHERE status = 'new'${tenantFilter}`, tenantParams);
    const [leadsQualified] = await query(`SELECT COUNT(*) as count FROM leads WHERE status = 'qualified'${tenantFilter}`, tenantParams);
    const [leadsConverted] = await query(`SELECT COUNT(*) as count FROM leads WHERE status = 'converted'${tenantFilter}`, tenantParams);

    // Recent leads
    const recentLeads = await query(
      `SELECT id, first_name, last_name, company, status, rating, source, email, phone, created_at 
       FROM leads WHERE 1=1${tenantFilter} ORDER BY created_at DESC LIMIT 5`,
      tenantParams
    );

    // Deals summary
    const [dealsTotal] = await query(`SELECT COUNT(*) as count FROM deals WHERE 1=1${tenantFilter}`, tenantParams);
    const [dealsOpen] = await query(`SELECT COUNT(*) as count FROM deals WHERE status = 'open'${tenantFilter}`, tenantParams);
    const [dealsWon] = await query(`SELECT COUNT(*) as count FROM deals WHERE status = 'won'${tenantFilter}`, tenantParams);
    const [dealsLost] = await query(`SELECT COUNT(*) as count FROM deals WHERE status = 'lost'${tenantFilter}`, tenantParams);
    const [pipelineValue] = await query(`SELECT COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'open'${tenantFilter}`, tenantParams);
    const [wonValue] = await query(`SELECT COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'won'${tenantFilter}`, tenantParams);

    // Recent deals
    const recentDeals = await query(
      `SELECT d.id, d.name, d.amount, d.status, d.probability, d.expected_close_date,
              a.name as account_name, ps.name as stage_name
       FROM deals d
       LEFT JOIN accounts a ON d.account_id = a.id
       LEFT JOIN pipeline_stages ps ON d.stage_id = ps.id
       WHERE 1=1${tenantFilter ? ' AND d.tenant_id = ?' : ''} 
       ORDER BY d.created_at DESC LIMIT 5`,
      tenantParams
    );

    // Accounts summary
    const [accountsTotal] = await query(`SELECT COUNT(*) as count FROM accounts WHERE 1=1${tenantFilter}`, tenantParams);
    
    // Contacts summary
    const [contactsTotal] = await query(`SELECT COUNT(*) as count FROM contacts WHERE 1=1${tenantFilter}`, tenantParams);

    // Activities summary
    const [activitiesOverdue] = await query(
      `SELECT COUNT(*) as count FROM activities 
       WHERE due_date < CURDATE() AND status NOT IN ('completed', 'cancelled')${tenantFilter}`,
      tenantParams
    );
    const [activitiesToday] = await query(
      `SELECT COUNT(*) as count FROM activities 
       WHERE due_date = CURDATE() AND status NOT IN ('completed', 'cancelled')${tenantFilter}`,
      tenantParams
    );
    const [activitiesUpcoming] = await query(
      `SELECT COUNT(*) as count FROM activities 
       WHERE due_date > CURDATE() AND due_date <= CURDATE() + INTERVAL 7 DAY 
       AND status NOT IN ('completed', 'cancelled')${tenantFilter}`,
      tenantParams
    );

    // Upcoming activities
    const upcomingActivities = await query(
      `SELECT id, type, subject, due_date, due_time, priority, status, related_type
       FROM activities 
       WHERE due_date >= CURDATE() AND status NOT IN ('completed', 'cancelled')${tenantFilter}
       ORDER BY due_date ASC, due_time ASC LIMIT 5`,
      tenantParams
    );

    // Pipeline stages with deal counts
    let pipelineStages = [];
    const [defaultPipeline] = await query(
      'SELECT id, name FROM pipelines WHERE tenant_id = ? AND is_default = 1',
      [tenantId]
    );
    if (defaultPipeline) {
      pipelineStages = await query(
        `SELECT ps.name, COUNT(d.id) as deal_count, COALESCE(SUM(d.amount), 0) as total_value
         FROM pipeline_stages ps
         LEFT JOIN deals d ON d.stage_id = ps.id AND d.tenant_id = ? AND d.status = 'open'
         WHERE ps.pipeline_id = ?
         GROUP BY ps.id, ps.name
         ORDER BY ps.sort_order`,
        [tenantId, defaultPipeline.id]
      );
    }

    // Get current date/time for context
    const now = new Date();
    const timeOfDay = now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening';

    return {
      currentDateTime: now.toISOString(),
      timeOfDay,
      leads: {
        total: leadsTotal?.count || 0,
        new: leadsNew?.count || 0,
        qualified: leadsQualified?.count || 0,
        converted: leadsConverted?.count || 0,
        recentLeads: recentLeads.map(l => ({
          name: `${l.first_name} ${l.last_name || ''}`.trim(),
          company: l.company,
          status: l.status,
          rating: l.rating,
          source: l.source
        }))
      },
      deals: {
        total: dealsTotal?.count || 0,
        open: dealsOpen?.count || 0,
        won: dealsWon?.count || 0,
        lost: dealsLost?.count || 0,
        pipelineValue: parseFloat(pipelineValue?.value) || 0,
        wonValue: parseFloat(wonValue?.value) || 0,
        recentDeals: recentDeals.map(d => ({
          name: d.name,
          amount: d.amount,
          status: d.status,
          stage: d.stage_name,
          account: d.account_name,
          expectedClose: d.expected_close_date
        }))
      },
      accounts: {
        total: accountsTotal?.count || 0
      },
      contacts: {
        total: contactsTotal?.count || 0
      },
      activities: {
        overdue: activitiesOverdue?.count || 0,
        today: activitiesToday?.count || 0,
        upcoming: activitiesUpcoming?.count || 0,
        upcomingList: upcomingActivities.map(a => ({
          type: a.type,
          subject: a.subject,
          dueDate: a.due_date,
          priority: a.priority,
          relatedTo: a.related_type
        }))
      },
      pipeline: {
        name: defaultPipeline?.name || 'Sales Pipeline',
        stages: pipelineStages
      }
    };
  } catch (error) {
    console.error('Error fetching CRM context:', error);
    return {
      error: 'Unable to fetch CRM data',
      leads: { total: 0 },
      deals: { total: 0 },
      accounts: { total: 0 },
      contacts: { total: 0 },
      activities: { overdue: 0, today: 0, upcoming: 0 }
    };
  }
}

// Chat endpoint
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;
    const tenantId = req.tenantId;
    const userId = req.user.id;

    if (!message) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    // Check if OpenAI API key is configured
    const openai = getOpenAIClient();
    if (!openai) {
      // Fallback to simple rule-based responses
      const fallbackResponse = await getFallbackResponse(message, tenantId);
      return res.json({
        success: true,
        data: {
          response: fallbackResponse.text,
          actions: fallbackResponse.actions || [],
          fallback: true
        }
      });
    }

    // Fetch CRM context
    const crmContext = await getCRMContext(tenantId, userId);

    // Build messages array
    const chatMessages = [
      { role: 'system', content: getSystemPrompt(crmContext) },
      ...conversationHistory.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: message }
    ];

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini', // Cost-effective model, can upgrade to gpt-4 if needed
      messages: chatMessages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const aiResponse = completion.choices[0]?.message?.content || 'I apologize, but I couldn\'t generate a response. Please try again.';

    // Extract any action suggestions from the response
    const actions = extractActions(aiResponse, message);

    res.json({
      success: true,
      data: {
        response: aiResponse,
        actions,
        usage: {
          promptTokens: completion.usage?.prompt_tokens,
          completionTokens: completion.usage?.completion_tokens,
          totalTokens: completion.usage?.total_tokens
        }
      }
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    
    // If OpenAI fails, use fallback
    const fallbackResponse = await getFallbackResponse(req.body.message, req.tenantId);
    res.json({
      success: true,
      data: {
        response: fallbackResponse.text,
        actions: fallbackResponse.actions || [],
        fallback: true
      }
    });
  }
});

// Fallback response function when OpenAI is not available
async function getFallbackResponse(message, tenantId) {
  const lowerMessage = message.toLowerCase();
  const tenantFilter = tenantId ? ' AND tenant_id = ?' : '';
  const tenantParams = tenantId ? [tenantId] : [];

  try {
    // Lead queries
    if (lowerMessage.includes('lead') || lowerMessage.includes('leads')) {
      const [total] = await query(`SELECT COUNT(*) as count FROM leads WHERE 1=1${tenantFilter}`, tenantParams);
      const [newLeads] = await query(`SELECT COUNT(*) as count FROM leads WHERE status = 'new' AND created_at >= CURDATE() - INTERVAL 7 DAY${tenantFilter}`, tenantParams);
      
      return {
        text: `📊 You have **${total?.count || 0}** total leads. ${newLeads?.count || 0} are new this week.`,
        actions: [{ label: 'View Leads', path: '/leads' }, { label: 'Add Lead', path: '/leads?action=new' }]
      };
    }

    // Deal queries
    if (lowerMessage.includes('deal') || lowerMessage.includes('deals') || lowerMessage.includes('pipeline')) {
      const [open] = await query(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'open'${tenantFilter}`, tenantParams);
      const [won] = await query(`SELECT COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'won'${tenantFilter}`, tenantParams);
      
      return {
        text: `💰 You have **${open?.count || 0}** open deals worth **AED ${(open?.value || 0).toLocaleString()}**. Won revenue: **AED ${(won?.value || 0).toLocaleString()}**`,
        actions: [{ label: 'View Deals', path: '/deals' }, { label: 'Add Deal', path: '/deals?action=new' }]
      };
    }

    // Activity queries
    if (lowerMessage.includes('activity') || lowerMessage.includes('activities') || lowerMessage.includes('task') || lowerMessage.includes('overdue')) {
      const [overdue] = await query(`SELECT COUNT(*) as count FROM activities WHERE due_date < CURDATE() AND status NOT IN ('completed', 'cancelled')${tenantFilter}`, tenantParams);
      const [today] = await query(`SELECT COUNT(*) as count FROM activities WHERE due_date = CURDATE()${tenantFilter}`, tenantParams);
      
      return {
        text: `📋 You have **${overdue?.count || 0}** overdue activities and **${today?.count || 0}** due today.`,
        actions: [{ label: 'View Activities', path: '/activities' }, { label: 'View Calendar', path: '/calendar' }]
      };
    }

    // Account queries
    if (lowerMessage.includes('account') || lowerMessage.includes('company') || lowerMessage.includes('companies')) {
      const [total] = await query(`SELECT COUNT(*) as count FROM accounts WHERE 1=1${tenantFilter}`, tenantParams);
      
      return {
        text: `🏢 You have **${total?.count || 0}** accounts in the system.`,
        actions: [{ label: 'View Accounts', path: '/accounts' }, { label: 'Add Account', path: '/accounts?action=new' }]
      };
    }

    // Contact queries
    if (lowerMessage.includes('contact') || lowerMessage.includes('contacts')) {
      const [total] = await query(`SELECT COUNT(*) as count FROM contacts WHERE 1=1${tenantFilter}`, tenantParams);
      
      return {
        text: `👥 You have **${total?.count || 0}** contacts in your CRM.`,
        actions: [{ label: 'View Contacts', path: '/contacts' }, { label: 'Add Contact', path: '/contacts?action=new' }]
      };
    }

    // Report/stats queries
    if (lowerMessage.includes('report') || lowerMessage.includes('stats') || lowerMessage.includes('summary') || lowerMessage.includes('overview')) {
      const [leads] = await query(`SELECT COUNT(*) as count FROM leads WHERE 1=1${tenantFilter}`, tenantParams);
      const [deals] = await query(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'open'${tenantFilter}`, tenantParams);
      const [won] = await query(`SELECT COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'won'${tenantFilter}`, tenantParams);
      
      return {
        text: `📈 **Quick Summary:**\n• Leads: ${leads?.count || 0}\n• Open Deals: ${deals?.count || 0} (AED ${(deals?.value || 0).toLocaleString()})\n• Won Revenue: AED ${(won?.value || 0).toLocaleString()}`,
        actions: [{ label: 'View Reports', path: '/reports' }]
      };
    }

    // Help query
    if (lowerMessage.includes('help') || lowerMessage.includes('what can you')) {
      return {
        text: `🤖 I can help you with:\n• **Leads** - Check lead counts and status\n• **Deals** - View pipeline and revenue\n• **Activities** - See overdue and upcoming tasks\n• **Accounts & Contacts** - Get counts\n• **Reports** - Quick summary\n\nJust ask me naturally!`,
        actions: []
      };
    }

    // Default response
    return {
      text: `I understand you're asking about "${message}". I can help with leads, deals, activities, accounts, contacts, and reports. What would you like to know?`,
      actions: [{ label: 'View Dashboard', path: '/dashboard' }]
    };
  } catch (error) {
    console.error('Fallback response error:', error);
    return {
      text: 'I apologize, but I encountered an error. Please try again.',
      actions: []
    };
  }
}

// Extract suggested actions from AI response
function extractActions(response, originalMessage) {
  const actions = [];
  const lowerResponse = response.toLowerCase();
  const lowerMessage = originalMessage.toLowerCase();

  if (lowerResponse.includes('lead') || lowerMessage.includes('lead')) {
    actions.push({ label: 'View Leads', path: '/leads' });
  }
  if (lowerResponse.includes('deal') || lowerMessage.includes('deal')) {
    actions.push({ label: 'View Deals', path: '/deals' });
  }
  if (lowerResponse.includes('activit') || lowerMessage.includes('task')) {
    actions.push({ label: 'View Activities', path: '/activities' });
  }
  if (lowerResponse.includes('contact') || lowerMessage.includes('contact')) {
    actions.push({ label: 'View Contacts', path: '/contacts' });
  }
  if (lowerResponse.includes('account') || lowerMessage.includes('account')) {
    actions.push({ label: 'View Accounts', path: '/accounts' });
  }

  return actions.slice(0, 2); // Max 2 actions
}

// Quick stats endpoint for chatbot initialization
router.get('/quick-stats', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const crmContext = await getCRMContext(tenantId, req.user.id);
    
    res.json({
      success: true,
      data: {
        leads: crmContext.leads.total,
        deals: crmContext.deals.open,
        pipelineValue: crmContext.deals.pipelineValue,
        activitiesOverdue: crmContext.activities.overdue,
        activitiesToday: crmContext.activities.today
      }
    });
  } catch (error) {
    console.error('Quick stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// Debug endpoint to check OpenAI configuration
router.get('/debug', authMiddleware, (req, res) => {
  const hasKey = !!process.env.OPENAI_API_KEY;
  const keyLength = process.env.OPENAI_API_KEY?.length || 0;
  const keyPrefix = process.env.OPENAI_API_KEY?.substring(0, 10) || 'N/A';
  const client = getOpenAIClient();
  
  res.json({
    success: true,
    debug: {
      hasOpenAIKey: hasKey,
      keyLength: keyLength,
      keyPrefix: keyPrefix,
      clientInitialized: !!client,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    }
  });
});

export default router;


# Trasealla CRM - Backend API

A powerful, multi-industry CRM backend built with Node.js and Express.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- MySQL 8.0+

### Installation

```bash
# Install dependencies
npm install

# Create .env file (copy from config)
cp src/config.js .env  # Edit with your settings

# Start development server
npm run dev
```

### Default Credentials

| Role  | Username | Password      |
|-------|----------|---------------|
| Admin | admin    | Trasealla123  |
| Demo  | demo     | demo123       |

## 📡 API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/session` - Get current session

### Staff
- `GET /api/staff` - List all staff
- `POST /api/staff` - Create staff (admin only)
- `PATCH /api/staff/:id` - Update staff
- `DELETE /api/staff/:id` - Delete staff (admin only)

### Accounts
- `GET /api/accounts` - List accounts
- `POST /api/accounts` - Create account
- `GET /api/accounts/:id` - Get account
- `PATCH /api/accounts/:id` - Update account
- `DELETE /api/accounts/:id` - Delete account

### Contacts
- `GET /api/contacts` - List contacts
- `POST /api/contacts` - Create contact
- `PATCH /api/contacts/:id` - Update contact
- `DELETE /api/contacts/:id` - Delete contact

### Leads
- `GET /api/leads` - List leads
- `POST /api/leads` - Create lead
- `PATCH /api/leads/:id` - Update lead
- `POST /api/leads/:id/convert` - Convert lead
- `DELETE /api/leads/:id` - Delete lead

### Deals
- `GET /api/deals` - List deals
- `POST /api/deals` - Create deal
- `PATCH /api/deals/:id` - Update deal
- `DELETE /api/deals/:id` - Delete deal

### Activities
- `GET /api/activities` - List activities
- `POST /api/activities` - Create activity
- `PATCH /api/activities/:id` - Update activity
- `DELETE /api/activities/:id` - Delete activity

### Pipelines
- `GET /api/pipelines` - List pipelines with stages
- `POST /api/pipelines` - Create pipeline
- `PATCH /api/pipelines/:id` - Update pipeline
- `DELETE /api/pipelines/:id` - Delete pipeline

### Stats
- `GET /api/stats` - Get dashboard statistics

### Appointments (Beauty Center)
- `GET /api/appointments` - List appointments (with pagination and filters)
- `POST /api/appointments` - Create appointment
- `GET /api/appointments/:id` - Get appointment details
- `PATCH /api/appointments/:id` - Update appointment
- `DELETE /api/appointments/:id` - Delete appointment
- `GET /api/appointments/staff/:staff_id/availability` - Get staff availability
- `GET /api/appointments/dashboard/today` - Get today's appointments

### Loyalty Program
- `GET /api/loyalty` - List loyalty programs
- `POST /api/loyalty` - Create loyalty program
- `PATCH /api/loyalty/:id` - Update loyalty program

### Staff Schedule
- `GET /api/staff-schedule` - Get staff schedules
- `POST /api/staff-schedule` - Create schedule
- `PATCH /api/staff-schedule/:id` - Update schedule

## ⚙️ Configuration

Edit `src/config.js` or create a `.env` file:

```env
PORT=4000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=trasealla_crm
JWT_SECRET=your_secret_key
FRONTEND_URL=http://localhost:5173
```

## 🗄️ Database

The application automatically creates:
- Database `trasealla_crm`
- All required tables
- Default admin user
- Default sales pipeline with stages

## 📁 Project Structure

```
crm-backend/
├── src/
│   ├── index.js          # Server entry point
│   ├── config.js         # Configuration
│   ├── lib/
│   │   └── database.js   # Database connection & init
│   ├── middleware/
│   │   └── auth.js       # Authentication middleware
│   └── routes/
│       ├── auth.js       # Authentication routes
│       ├── staff.js      # Staff management
│       ├── accounts.js   # Accounts CRUD
│       ├── contacts.js   # Contacts CRUD
│       ├── leads.js      # Leads CRUD
│       ├── deals.js      # Deals CRUD
│       ├── activities.js # Activities CRUD
│       ├── pipelines.js  # Pipelines CRUD
│       └── stats.js      # Dashboard stats
└── package.json
```

## 🔐 Security

- JWT-based authentication
- Password hashing with bcrypt
- CORS protection
- Cookie-based session management

## 📄 License

Trasealla © 2024



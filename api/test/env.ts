// Test environment. Imported first by every test so the settings are in place before the
// server's modules read them.
process.env.NODE_ENV = "test";
process.env.PAYMENTS_PROVIDER = "simulated";
process.env.SIM_DELAY_MS = "40";
process.env.VIRTUAL_DEVICES = "off";
process.env.OTP_ECHO = "on";
process.env.MERCHANT_APP_URL = "http://localhost:5310";
process.env.ADMIN_APP_URL = "http://localhost:5320";
process.env.ADMIN_SETUP_TOKEN = "test-setup-token";
process.env.CALLBACK_SECRET = "test-callback-secret";
delete process.env.DATABASE_URL;

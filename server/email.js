// Transactional email for LAN Party (welcome / password reset / deactivation).
// Uses the same SMTP account as Retroboard (vaultjump.noreply@gmail.com). Credentials come from
// SMTP_* env vars, or a gitignored JSON key file (server/smtp.key) alongside the other *.key files:
//   { "host": "...", "port": 587, "user": "...", "pass": "...", "from": "LAN Party <...>", "secure": false }
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const APP_NAME = 'LAN Party';
const COMPANY = 'Jump Vault LLC';
const APP_URL = (process.env.PUBLIC_APP_URL || 'https://lanparty.thejumpvault.com').replace(/\/$/, '');

function loadConfig() {
  const e = process.env;
  let cfg = { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.SMTP_FROM, secure: e.SMTP_SECURE === 'true' };
  if (!cfg.host || !cfg.user || !cfg.pass) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'smtp.key'), 'utf8')) }; } catch (_) { /* not configured */ }
  }
  return cfg;
}

let transporter = null;
let fromAddr = '';
function getTransporter() {
  if (transporter) return transporter;
  const cfg = loadConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  const port = parseInt(cfg.port || '587', 10);
  transporter = nodemailer.createTransport({ host: cfg.host, port, secure: cfg.secure || port === 465, auth: { user: cfg.user, pass: cfg.pass } });
  fromAddr = cfg.from || `${APP_NAME} <${cfg.user}>`;
  return transporter;
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const btn = (href, label) => `<a href="${href}" style="display:inline-block;background:#c8433a;color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:8px;">${label}</a>`;

function wrap(bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0e0604;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0e0604;padding:40px 0;"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#161011;border:1px solid rgba(224,138,110,.2);border-radius:14px;overflow:hidden;">
<tr><td style="background:#7a0d0d;padding:22px 32px;"><span style="color:#fff;font-size:20px;font-weight:800;">🎮 ${APP_NAME}</span></td></tr>
<tr><td style="padding:32px;color:#e9ddd6;">${bodyHtml}</td></tr>
<tr><td style="background:#120a08;padding:16px 32px;text-align:center;"><span style="color:#9a8078;font-size:12px;">© ${new Date().getFullYear()} ${COMPANY}</span></td></tr>
</table></td></tr></table></body></html>`;
}

async function send(to, subject, html) {
  const t = getTransporter();
  if (!t) { console.warn('[email] SMTP not configured; skipped:', subject, '->', to); return false; }
  try { await t.sendMail({ from: fromAddr, to, subject, html }); console.log('[email] sent:', subject, '->', to); return true; }
  catch (err) { console.error('[email] send failed:', subject, err.message); return false; }
}

function sendWelcome(username, to) {
  return send(to, `Welcome to ${APP_NAME}!`, wrap(`
    <h1 style="margin:0 0 12px;color:#f0a070;font-size:22px;">Welcome, ${esc(username)}! 🎉</h1>
    <p style="line-height:1.6;margin:0 0 20px;">Your ${APP_NAME} account is ready. Jump in — voice &amp; video, party activities, synced music, and live streams with your crew.</p>
    <p style="margin:0 0 28px;">${btn(APP_URL + '/app/', 'Open LAN Party')}</p>
    <p style="color:#9a8078;font-size:13px;margin:0;">If you didn't create this account, you can ignore this email.</p>`));
}

function sendPasswordReset(username, to, token) {
  const link = `${APP_URL}/app/?reset=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;
  return send(to, `Reset your ${APP_NAME} password`, wrap(`
    <h1 style="margin:0 0 12px;color:#f0a070;font-size:22px;">Password reset</h1>
    <p style="line-height:1.6;margin:0 0 16px;">Hi ${esc(username)}, we received a request to reset your password. This link expires in 1 hour.</p>
    <p style="margin:0 0 20px;">${btn(link, 'Reset password')}</p>
    <p style="color:#9a8078;font-size:13px;margin:0;">Or enter this code in the app: <b style="color:#e9ddd6;">${esc(token)}</b>. Didn't request this? Ignore this email.</p>`));
}

function sendDeactivationConfirm(username, to, token) {
  const link = `${APP_URL}/app/?deactivate=${encodeURIComponent(token)}&email=${encodeURIComponent(to)}`;
  return send(to, `Confirm your ${APP_NAME} account deactivation`, wrap(`
    <h1 style="margin:0 0 12px;color:#f0a070;font-size:22px;">Confirm deactivation</h1>
    <p style="line-height:1.6;margin:0 0 16px;">Hi ${esc(username)}, confirm you want to deactivate your account. This removes your data and can't be undone.</p>
    <p style="margin:0 0 20px;">${btn(link, 'Confirm deactivation')}</p>
    <p style="color:#9a8078;font-size:13px;margin:0;">If you didn't request this, ignore this email — your account stays active.</p>`));
}

function sendDeactivationDone(username, to) {
  return send(to, `Your ${APP_NAME} account was deactivated`, wrap(`
    <h1 style="margin:0 0 12px;color:#f0a070;font-size:22px;">Sorry to see you go 💔</h1>
    <p style="line-height:1.6;margin:0 0 16px;">Hi ${esc(username)}, your ${APP_NAME} account has been deactivated and your data removed. Thanks for hanging out with us.</p>
    <p style="color:#9a8078;font-size:13px;margin:0;">Changed your mind? You're always welcome to sign up again.</p>`));
}

async function verify() {
  const t = getTransporter();
  if (!t) return { ok: false, reason: 'SMTP not configured' };
  try { await t.verify(); return { ok: true, from: fromAddr }; } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { sendWelcome, sendPasswordReset, sendDeactivationConfirm, sendDeactivationDone, verify, isConfigured: () => !!getTransporter() };

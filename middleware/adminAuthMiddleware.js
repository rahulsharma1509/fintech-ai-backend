/**
 * middleware/adminAuthMiddleware.js
 * ----------------------------------
 * HTTP Basic Auth protection for the /admin routes.
 *
 * Setup: add to .env:
 *   ADMIN_USERNAME=admin
 *   ADMIN_PASSWORD=your-strong-password-here
 *
 * ⚠️  Basic Auth sends credentials in base64 (not encrypted).
 *     Always use HTTPS in production (Render provides HTTPS automatically).
 *     For a hardened setup, replace with JWT or session-based auth.
 */

function adminAuth(req, res, next) {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "changeme";

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Dashboard"');
    return res.status(401).send("Authentication required");
  }

  const base64 = authHeader.slice("Basic ".length);
  const [user, pass] = Buffer.from(base64, "base64").toString().split(":");

  if (user === username && pass === password) {
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Admin Dashboard"');
  return res.status(401).send("Invalid credentials");
}

module.exports = { adminAuth };

// Prints the SQL that creates an admin account with a temporary password.
// Usage: node scripts/create-admin.mjs <username> "<Full Name>" <temporary-password>
// The admin must change the password at first sign-in.
import { hashPassword } from '../src/crypto.js';

const [username, name, password] = process.argv.slice(2);
if (!username || !name || !password || password.length < 8) {
  console.error('Usage: node scripts/create-admin.mjs <username> "<Full Name>" <temporary-password (8+ chars)>');
  process.exit(1);
}
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const { hash, salt } = await hashPassword(password);
console.log(
  `INSERT INTO users (name, username, pass_hash, salt, role, can_edit_stages, active, must_change_password, created_at) ` +
  `VALUES (${q(name)}, ${q(username)}, ${q(hash)}, ${q(salt)}, 'admin', 1, 1, 1, ${q(new Date().toISOString())});`
);

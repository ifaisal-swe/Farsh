'use strict';
/**
 * Create a DASHBOARD_PASSWORD_HASH value (scrypt) so the plain password never has to be stored in Railway.
 *
 *   npm run hash-password            (asks for the password; nothing is echoed or saved)
 *   echo "my long password" | node scripts/hash-password.js
 */
const { hashPassword } = require('../server/auth');

function readHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    process.stdout.write(prompt);
    let pw = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(pw); return; }
      if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      if (ch === '\u007f' || ch === '\b') { pw = pw.slice(0, -1); return; }
      pw += ch;
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const pw = await readHidden('Dashboard password (min. 12 characters): ');
  if (!pw || pw.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
  console.log('\nSet this as the Railway variable DASHBOARD_PASSWORD_HASH:\n');
  console.log(hashPassword(pw));
  console.log('');
})();

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Example /auth route
app.post('/auth', (req, res) => {
  const user = req.body;
  const { id, first_name, last_name, username, hash, auth_date } = user;

  // 1. Create the data_check_string (sort user keys, exclude hash)
  const secretKey = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
  const checkString = Object.keys(user)
    .filter(key => key !== 'hash')
    .sort()
    .map(key => `${key}=${user[key]}`)
    .join('\n');

  // 2. Calculate HMAC
  const hmac = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (hmac !== hash) {
    return res.status(403).send('Unauthorized: Invalid Telegram hash');
  }

  // 3. If valid, proceed to store user data or create a session
  // Example: respond with success
  res.send(`Hello, ${first_name}, we got your data and it’s verified!`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server running on port', PORT));

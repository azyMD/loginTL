const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();
const app = express();

// 1. Parse JSON bodies
app.use(bodyParser.json());

// 2. Serve files from the "public" folder at the root path
app.use(express.static('public'));

// 3. Optional: Define a GET route for "/"
//    This ensures that visiting "/" explicitly serves "public/index.html"
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. Telegram verification route for POST /auth
app.post('/auth', (req, res) => {
  const user = req.body;
  const { id, first_name, last_name, username, hash, auth_date } = user;

  // (A) Create secretKey from BOT_TOKEN
  const secretKey = crypto
    .createHash('sha256')
    .update(process.env.BOT_TOKEN)
    .digest();

  // (B) Build checkString (exclude hash, sort keys)
  const checkString = Object.keys(user)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${user[key]}`)
    .join('\n');

  // (C) Calculate HMAC
  const hmac = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (hmac !== hash) {
    return res.status(403).send('Unauthorized: Invalid Telegram hash');
  }

  // If valid, respond or store user info in DB, create a session, etc.
  res.send(`Hello, ${first_name}! We verified your Telegram data.`);
});

// 5. Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

app.use(bodyParser.json());
app.use(express.static('public')); // Serve static files from "public"

// Telegram Authentication Endpoint
app.get('/auth', (req, res) => {
  const { id, first_name, last_name, username, hash } = req.query;

  // Step 1: Validate the hash
  const secretKey = crypto.createHash('sha256').update(process.env.BOT_TOKEN).digest();
  const dataCheckString = Object.keys(req.query)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${req.query[key]}`)
    .join('\n');

  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (hmac !== hash) {
    return res.status(403).send('Unauthorized: Invalid hash');
  }

  // Step 2: Respond with success
  res.send(`Hello, ${first_name}! Your Telegram login is successful.`);
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

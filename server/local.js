// Run locally: node server/local.js  →  http://localhost:3000
const app = require('./app');
const port = process.argv[2] || process.env.PORT || 3000;
app.listen(port, () => console.log(`Dial-a-Dollar running on http://localhost:${port}`));

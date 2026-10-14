# LinkForge — Mini Link It

A simple, responsive URL shortener with a soft pastel gradient, a clean white creation form, custom aliases, and a small link history with copy/delete and click counts.

## Run locally

1. Open the `linkforge` folder in VS Code.
2. Install Node.js 18 or newer.
3. In the terminal, run `npm start`.
4. Open http://localhost:3000

No additional npm packages are required.

## Deployment

Host the entire Node.js project on a service that supports persistent server processes. GitHub Pages alone cannot run the Node.js backend. Data is written to `data/links.json` and **will not persist on hosts with ephemeral disks**. For reliable public hosting, migrate storage to a persistent database and add authentication/abuse controls before allowing public link management.

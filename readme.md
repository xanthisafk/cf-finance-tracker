# Finance Tracker
This guide explains how to deploy the **Finance Tracker** app to Cloudflare. It also highlights why hosting your own version is beneficial, and what makes the app fast, private, and convenient.

---

## Why Host Your Own Version?

Running your own deployment means:

* Full Privacy - Your data stays entirely in your Cloudflare D1 database. The app does not collect, log, or transmit your financial information anywhere else.
* Full Control - You manage your own limits, currency settings, JWT keys, and database.
* No Third Party Lock In - Unlike using a public app, your production version remains yours forever.

The app is a PWA (Progressive Web App), so you can install it on both mobile and desktop, making it feel like a native app.

---

## Requirements

Before deploying, ensure you have:

* A Cloudflare account
* Node.js installed
* npm installed
* Wrangler CLI installed

Install Wrangler if needed:

```
npm install -g wrangler
```

---

## 1. Rename the Configuration File

Rename the provided:

```
wrangler.toml.demo → wrangler.toml
```

This becomes your main deployment config.

---

## 2. Create a D1 Database

In your Cloudflare dashboard:

1. Go to Workers & D1
2. Create a D1 database named `finance-db`
3. Copy the generated Database ID
4. Paste it into your `wrangler.toml`

OR

1. Run `npx wrangler d1 create finance-db` on console.
2. Copy the generated Database ID
3. Paste it into your `wrangler.toml`

Replace `YOUR_DATABASE_ID_HERE` with Database ID:

```
[[d1_databases]]
binding = "DB"
database_name = "finance-db"
database_id = "YOUR_DATABASE_ID_HERE"
```

---

## 3. Generate a Secure JWT Secret

Generate a strong JWT secret using a generator such as:
[https://djecrety.ir/](https://djecrety.ir/)

Add it into:

```
[vars]
JWT_SECRET = "YOUR_GENERATED_SECURE_KEY"
```

---

## 4. Initialize the Database Schema

Run the schema migration remotely:

```
npx wrangler d1 execute --remote finance-db --file=./schema.sql
```

This sets up tables and initial structure.

---

## 5. Configure Variables

Inside `wrangler.toml`, adjust the following:

### `CURRENCY_SYMBOL`

Self explanatory - choose your symbol (e.g., $, €, ₹).

### `FORCE_LOCALE`

Sets the locale format for numbers & currency.
Examples:

* `en-US`
* `en-IN`
* Leave empty to use the client’s browser locale.

### `MAX_USERS`

Sets how many user accounts can exist.
Useful if you're limiting access to a family or personal use.

---

## 🚀 Deploying

Once configured, deploy using:

```
npx wrangler deploy
```

Your Finance Tracker should now be live.
Visit the logged URL and begin using your private, fast, self‑hosted finance tracking PWA.

---

## 📌 Example Minimal `wrangler.toml`

```
name = "finance-tracker"
main = "src/index.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "finance-db"
database_id = "YOUR_DATABASE_ID"

[vars]
JWT_SECRET = "YOUR_SECURE_KEY"
CURRENCY_SYMBOL = "₹"
FORCE_LOCALE = "en-IN"
MAX_USERS = 2
```

---

## 📝 Editing Your Data

If you need to modify or inspect data later, you can do so directly in the `Cloudflare Dashboard → D1 → Data`.

No external servers involved.

---

You're ready to deploy and self host your lightning fast, private finance tracking app!

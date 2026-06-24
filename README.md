<div align="center">
  <h1>💖 Tsun Bot</h1>
  <p><i>The ultimate tsundere economy, battle, and slavery bot for Discord!</i></p>
</div>

Welcome to Tsun Bot! This is a feature-rich, deeply integrated economy bot running on Node.js and MongoDB. It features a fully dynamic stock market, an RPG combat system, player-to-player slavery, and a snarky tsundere personality!

If you are a new user wanting to host this bot yourself, **read this guide very carefully**. 

---

## 🛠️ Complete Setup Guide

This guide provides extremely detailed, step-by-step instructions for acquiring every API key and credential required in the `.env` file and getting the bot running on your machine.

### 1. Install Required Software
Before touching the code, you need two pieces of software installed on your server or computer:
1. **Node.js**: Download and install [Node.js (v18 or higher)](https://nodejs.org/). This is the engine that runs the bot.
2. **Git**: Download and install [Git](https://git-scm.com/). This allows you to clone the code.

Once installed, open your terminal (or Command Prompt) and run:
```bash
git clone <your-repo-link>
cd tsun
npm install
```
This will download all the necessary packages like `discord.js` and `mongoose`.

---

### 2. Discord Developer Portal (`DISCORD_TOKEN`)
The Discord Token is the master key that allows the bot to connect to Discord and read/send messages.

**URL to visit**: [Discord Developer Portal](https://discord.com/developers/applications)

#### Step-by-Step Instructions:
1. Log in with your Discord account.
2. Click the **"New Application"** button in the top right corner.
3. Enter a name for your bot (e.g., "Tsun"), accept the Terms of Service, and click **Create**.
4. On the left sidebar, click on **Bot**.
5. Look for the **Privileged Gateway Intents** section on this page.
   - **WHAT TO DO (CRITICAL)**: You **MUST** tick the checkboxes to enable **Server Members Intent** and **Message Content Intent**. If you do not do this, the bot will silently fail to read commands and track user data.
   - Click **Save Changes** at the bottom.
6. Scroll back up to the **Token** section and click **Reset Token**, then click **Yes, do it!**.
7. Click the **Copy** button.
   - **WHAT NOT TO DO**: **Never** share this token with anyone, and **never** commit it to GitHub. If anyone gets this token, they have full control over your bot.
8. Rename the `.env.example` file in your bot's folder to `.env`.
9. Paste your token into the `.env` file under `DISCORD_TOKEN`.

#### How to Invite the Bot to Your Server:
1. Still on the Developer Portal, go to **OAuth2 -> URL Generator** on the left sidebar.
2. Under "Scopes", tick the **`bot`** checkbox.
3. Scroll down to "Bot Permissions" and tick **Administrator**.
4. Copy the Generated URL at the very bottom of the page.
5. Paste that URL into your web browser, select your server, and click Authorize.

---

### 3. MongoDB (`MONGO_URI`)
The bot uses MongoDB to save user data, economy balances, and stock history. We will use MongoDB Atlas for a free cloud database.

**URL to visit**: [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register)

#### Step-by-Step Instructions:
1. Sign up for a free account and create a new Organization/Project if prompted.
2. Click **Build a Database** or **Create a Cluster**.
3. Select the **M0 Free** tier. Choose a cloud provider (AWS/GCP/Azure) and the region geographically closest to where your bot will be hosted. Click **Create**.
4. **Security Quickstart**:
   - **Authentication**: Create a Database User. Choose a username (e.g., `tsun_admin`) and click **Autogenerate Secure Password** (or type your own). 
   - **WHAT TO DO**: Copy this password immediately and save it somewhere safe; you will need it in a moment. Click **Create User**.
   - **Network Access**: Under "Where would you like to connect from?", select **My Local Environment**. In the IP Address field, enter `0.0.0.0/0` (which means "Allow Access from Anywhere"). This ensures your bot can connect regardless of where you host it. Click **Add Entry**.
5. Click **Finish and Close**, then go to your Database dashboard.
6. Click the **Connect** button next to your cluster.
7. Choose **Drivers** (Node.js).
8. Copy the connection string provided. It will look like this: `mongodb+srv://tsun_admin:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`
9. **WHAT TO DO**: 
   - Paste the string into your `.env` file as `MONGO_URI`.
   - Replace `<password>` with the password you generated in Step 4.
   - Insert a database name immediately before the `?`. For example: `...mongodb.net/TsunDatabase?retryWrites...`

---

### 4. Cloudinary (Images)
Cloudinary is used by the bot to compress and store user grids and generated images so Discord doesn't block large file uploads.

**URL to visit**: [Cloudinary Registration](https://cloudinary.com/users/register_free)

#### Step-by-Step Instructions:
1. Sign up for a free account.
2. Once logged in, navigate to your **Dashboard** (usually under Programmable Media -> Dashboard).
3. At the top of the dashboard, you will see your **Product Environment Credentials**.
4. **WHAT TO DO**:
   - Click the copy icon next to **Cloud Name** and paste it into `CLOUDINARY_CLOUD_NAME`.
   - Click the copy icon next to **API Key** and paste it into `CLOUDINARY_API_KEY`.
   - Click the copy icon next to **API Secret** and paste it into `CLOUDINARY_API_SECRET`.
5. **WHAT NOT TO DO**: Treat your API Secret like a password. Do not share it.

---

### 5. OpenRouter API (`OPENROUTER_API_KEY`)
OpenRouter acts as a proxy to access various AI models for the bot's conversational personality.

**URL to visit**: [OpenRouter](https://openrouter.ai/)

#### Step-by-Step Instructions:
1. Sign in (you can use your Discord or Google account).
2. Click on your profile in the top right and go to **Keys**.
3. Click the **Create Key** button. Name it "Tsun Bot".
4. A popup will appear with your API Key (starting with `sk-or-v1-`).
5. **WHAT TO DO**: Click copy and paste it into `OPENROUTER_API_KEY` in your `.env` file. You will never be able to see this key again once you close the popup.

---

### 6. Pollinations API (`POLLINATIONS_API_KEY`)
Used for generating images based on text prompts.

**URL to visit**: [Pollinations.ai](https://pollinations.ai/)

#### Step-by-Step Instructions:
1. Pollinations is uniquely designed to often work *without* an API key for basic public endpoints. 
2. **WHAT TO DO**: If you do not have a paid key, you can leave `POLLINATIONS_API_KEY=` blank in your `.env` file.

---

### 7. MyAnimeList API (`MAL_CLIENT_ID`)
Used to fetch anime and manga data directly from MyAnimeList.

**URL to visit**: [MyAnimeList API Config](https://myanimelist.net/apiconfig)

#### Step-by-Step Instructions:
1. Log into your MyAnimeList account.
2. Go to the API configuration page and agree to developer terms.
3. Click the **Create ID** button.
4. Fill out the application form:
   - **App Name**: Tsun Bot
   - **App Type**: Select "Hobbyist" or "Other".
   - **Redirect URI**: Enter `http://localhost`.
5. Click **Submit**.
6. **WHAT TO DO**: Look for the **Client ID** (a long string of numbers and letters). Copy this and paste it into `MAL_CLIENT_ID`.
7. **WHAT NOT TO DO**: Ignore the Client Secret.

---

### 8. Final Configuration & Launch!

Now that your `.env` file is fully loaded with API keys, you need to configure the bot's internal settings:

1. **Open `config.js` in a code editor.**
2. Scroll to the `ROLES` object. The bot heavily relies on assigning Discord roles for prestige ranks, custom titles, and the `MEMBER` role.
3. **Important**: Go to your Discord server's Server Settings -> Roles, and ensure every role listed in `config.js` exists exactly as spelled. 
   *For example, if `config.ROLES.MEMBER` is `"member"`, create a role called "member" in your Discord server.*
4. Adjust any economy values in `config.js` (like `DEFAULT_COINS` or `WEEKLY_GOAL`) to your liking.

**Start the Bot:**
In your terminal, run:
```bash
npm start
```
You should see a message in the console saying `🔌 Connecting to Database...` followed by `🚀 Tsun is online as Tsun#1234`. 

Congratulations, you have fully deployed your own open-source Tsun bot!

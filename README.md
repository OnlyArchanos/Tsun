<div align="center">
  <img src="https://i.ibb.co/hxvV5kjn/Cm.png" alt="Megumin" width="300" />
  
  <h1>Tsun Bot</h1>
  <p><i>It's not like I wanted you to host me or anything, baka!</i></p>
</div>

Hmph! So you actually want to set me up? I guess I can explain it to you since you'd probably mess it up otherwise. Don't get the wrong idea! I'm only doing this so you don't break my code.

Listen closely, idiot, because I'm only going to say this once. You need to set up the Discord Bot *and* the Web Dashboard. Pay attention!

<br/>

<div align="center">
  <img src="https://i.ibb.co/FqDbBcZq/Dm.png" alt="Megumin Smug" width="150" />
</div>

<br/>

## Table of Contents

- [Step 1: Prerequisites](#step-1-getting-the-boring-stuff)
- [Step 2: Discord Bot Setup](#step-2-the-discord-portal-pay-attention)
- [Step 3: MongoDB Database](#step-3-mongodb-database-dont-mess-this-up)
- [Step 4: Cloudinary](#step-4-cloudinary-for-images)
- [Step 5: Admin Control Panel](#step-5-the-admin-control-panel-dont-ignore-this)
- [Step 6: MyAnimeList API](#step-6-myanimelist-api-for-the-weeb-stuff)
- [Step 7: Web Dashboard](#step-7-setting-up-the-web-dashboard)
- [Step 8: Final Config and Launch](#step-8-final-config-and-launch)
- [Quick Reference: All .env Variables](#quick-reference-all-env-variables)

## Step 1: Getting the Boring Stuff

Ugh, fine! First you need **Node.js v18 or higher**. If you don't have it, what are you even doing here? Go download it right now:
- [Node.js](https://nodejs.org/) � Download the **LTS** version, not the experimental one. Make sure you check "Add to PATH" when installing, idiot!

You don't even need Git for this. Just go to my GitHub repository, click the green **Code** button, and click **Download ZIP**. Extract it somewhere safe. 

Once you extract it, go into the folder and double-click `StartBot.bat`! 

Don't panic when it stops immediately! It's just checking if you have a `.env` file. Since you don't (obviously), it will automatically create a blank one for you from `.env.example` and tell you to fill it out. I even automated the dependency installation and auto-updating so you literally just have to double-click that file. B-but don't think I did it just to make your life easier! It's just more efficient! (�_�)

<br/>

---

## Step 2: The Discord Portal (Pay Attention!)

I need a body to control, obviously! Go to the [Discord Developer Portal](https://discord.com/developers/applications) and log in with your normal Discord account. You don't need a special "developer" account, idiot.

1. Click **New Application** in the top right. Give me a decent name and agree to the terms.
2. You'll be on the **General Information** page. See that **Application ID**? That's your `DISCORD_CLIENT_ID`. You'll need it later for the web dashboard, so don't forget it!
3. Go to the **OAuth2** tab on the left. Look for **Client Secret** and click **Reset Secret**. Copy it IMMEDIATELY! That's your `DISCORD_CLIENT_SECRET`. If you close the page without copying it, it's gone forever and you'll have to reset it again. Don't show this to anyone, dummy!
4. Now, go to the **Bot** tab on the left.
5. Scroll down to **Privileged Gateway Intents**. This is **CRITICAL**! You **HAVE** to turn on **Presence Intent**, **Server Members Intent**, AND **Message Content Intent**. If you forget the Message Content Intent, I won't be able to read any commands and I'll literally ignore everyone. Your fault! Make sure you click the green **Save Changes** button!
6. Go up to the **Token** section, click **Reset Token**, and copy the long password. That's your `DISCORD_TOKEN`. **DO NOT SHOW THIS TO ANYONE!** Are you crazy? If someone steals it, they steal me! And if you accidentally push it to GitHub, Discord will destroy it instantly.
7. Now, go into my folder, find `.env.example`, rename it to `.env`, and paste that token next to `DISCORD_TOKEN=`.

### Inviting Me to Your Server

To invite me to your server, you need to generate a special link:
1. Go back to **OAuth2 > URL Generator**. 
2. Check the `bot` box. (You can also check `applications.commands` if you ever want to add slash commands later, whatever).
3. Once you check `bot`, a **Bot Permissions** menu appears below. Check **Administrator**. Don't be stingy! I need full permissions to manage roles and channels, or I'm going to crash.
4. Scroll to the bottom and copy the generated link. 
5. Paste it in a new browser tab. A Discord screen will pop up asking where to add me.
6. Open the **"Add to Server"** dropdown menu and select a server where you personally have "Manage Server" or "Administrator" rights (otherwise the server won't even show up, baka!).
7. Click **Continue**, review the permissions, click **Authorize**, and do the little human verification CAPTCHA.

If my role isn't high enough in your server settings to assign prestige roles, I'll throw an error. So go into your Server Settings → Roles and drag my role to the very top, got it?!

<br>

<div align="center">
  <img src="https://i.ibb.co/KpbbS35s/Am.png" alt="Megumin Pout" width="150" />
</div>

---

## Step 3: MongoDB Database (Don't Mess This Up!)

I need somewhere to store all the user balances, inventories, and stocks! We're using MongoDB Atlas because it's free. Listen closely, because if you mess up the connection string, I'm going to crash immediately.

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) and sign up. You don't need a credit card, so don't complain.
2. Create an organization/project, then click **Build a Database**.
3. **DO NOT** pick a paid tier unless you're rich! Pick the **M0 (Free)** deployment type.
4. Once it's created, you might see a **Security Quickstart** screen (or just go to Database Access on the left). 
5. Create a **Database User** with a username and password. 
   *   **WARNING:** Do **NOT** use special characters like `@`, `:`, `/`, or `?` in your password! It will literally break the URL and I'll refuse to connect. Stick to normal letters and numbers, idiot! **WRITE THE PASSWORD DOWN.**
6. Go to **Network Access** on the left. Click **Add IP Address** and choose **Allow Access From Anywhere** (`0.0.0.0/0`).
   *   **WARNING:** If you click "Current IP Address", only your personal computer can connect. When you try to host me on a real server, I'll crash instantly because I'll be blocked. So just use `0.0.0.0/0`!
7. Now, go to **Database** on the left, click **Connect** next to your cluster, and choose **Drivers** (Node.js).
8. Copy the connection string. It looks like: `mongodb+srv://username:<password>@cluster0...mongodb.net/?retryWrites=true`
9. **CRITICAL STEP:** Before you paste it into your `.env`, you have to edit it yourself:
   *   Replace `<password>` with your actual password. And **DELETE** the `<` and `>` brackets! I can't believe I have to tell you that.
   *   **ADD MY NAME!** Look at the `.net/` right before the `?`. You **MUST** insert `TsundereBot` right there so it looks like `.net/TsundereBot?retryWrites=...`. If you don't do this, MongoDB will just name the database `test` and dump all my precious data in a trash folder!
10. Paste the fixed string into your `.env` next to `MONGO_URI=`, and put the exact same string into `web/.env.local` next to `MONGODB_URI=`.

<br/>

---

## Step 4: Cloudinary (For Images)

If you want me to process user inventories and generate custom duel canvases without Discord yelling at me about file sizes, you need this. Don't skip it!

1. Go to [Cloudinary](https://cloudinary.com/users/register_free) and sign up for a free account.
2. Go to your **Dashboard**. Near the top, you'll see a section called **Product Environment**. Look for your **Cloud Name**. Copy it and put it in your `.env` as `CLOUDINARY_CLOUD_NAME`.
   *   *(Note: This is a random string, NOT your email address. Don't mess that up!)*
3. Now for the keys. They recently moved these, so pay attention! Click on **Settings** (the gear icon) or look for a button that says **Go to API Keys**.
4. On the **API Keys** page, you'll see a default key pair. 
5. Copy the **API Key** (it's a string of numbers) and paste it as `CLOUDINARY_API_KEY`.
6. Click the reveal icon next to the **API Secret**. Copy that long, messy string and paste it as `CLOUDINARY_API_SECRET`.
   *   **WARNING:** This secret gives full control over my image storage. If you leak this, I'm going to be so mad at you! If you ever think someone stole it, go back to that page and click Revoke immediately!

<br/>

---

## Step 5: The Admin Control Panel (DON'T IGNORE THIS!)

You probably looked at `SESSION_SECRET` and `DASHBOARD_PASSWORD` in the `.env` file and thought you could just leave them blank, right? WRONG!

1. **`SESSION_SECRET`**: I run my own internal web server in the background for an admin panel. This secret string encrypts your browser cookies. You **HAVE** to type a long random keyboard smash here (like `qwertyuiopasdfghjklzxcvbnmqwerty`). If you leave this blank, I will literally throw a fatal error and refuse to boot up. So don't even try it!
2. **`DASHBOARD_PASSWORD`**: When you visit my internal admin panel, I'm obviously going to ask for a password. If you leave this blank in the `.env`, I'll assume it's unsafe and I will automatically reject **ALL** login attempts, locking you out of your own control panel! Pick a password and write it down!

<br/>

---

## Step 6: MyAnimeList API (For the Weeb Stuff)

Do you want me to be able to look up anime and manga for you? Then you have to set this up! It's technically optional, but if you leave `MAL_CLIENT_ID` blank, any anime commands will just throw errors.

1. Go to your [MyAnimeList API Config](https://myanimelist.net/apiconfig) page. You have to log into your MAL account first, obviously.
2. Click the big button that says **Create ID** (or "Create new application").
3. It's going to ask you to fill out a boring form. Just put this:
   *   **App Name:** Tsun Bot (or whatever you want to call me)
   *   **App Type:** Select **Hobbyist** (or "Other") since you're not paying them!
   *   **Homepage URL:** Just put `http://localhost` or a link to your GitHub. It literally doesn't matter for a private bot.
   *   **App Redirect URL:** Also put `http://localhost`. I only need public data, so we don't actually need a real OAuth redirect, but MAL forces you to type something here anyway.
   *   **Description:** Type whatever, like "A discord bot for my friends". 
4. Click **Submit**.
5. You'll instantly see your new app listed. Copy the **Client ID** (you don't need the Client Secret for this). 
6. Paste that Client ID into your `.env` file right next to `MAL_CLIENT_ID=`. 

<br/>

<div align="center">
  <img src="https://i.ibb.co/MxjKPDh8/Bm.png" alt="Megumin Magic" width="200" />
</div>

---

## Step 7: Setting up the Web Dashboard

You thought we were done? Hah! You still have to configure my web interface so you can see all the fancy stats and graphs! 

1. Go into the `web` folder.
2. Copy `.env.local.example` and rename the copy to `.env.local`. Don't rename the original, keep the example file as a backup!
3. Open `.env.local` and fill in every single line. Here is what each one does, since I know you'd just stare at it blankly otherwise:
   * `MONGODB_URI`: Put the **EXACT** same MongoDB connection string you built in Step 3 here. Yes, the same one with `TsundereBot` in it. This is how the website reads from the same database as the bot.
   * `AUTH_SECRET`: This is a long random string that NextAuth uses to sign and encrypt session cookies for people logging into the web dashboard. Just mash your keyboard for 30+ characters. It doesn't matter what it is as long as it's random and long!
   * `DISCORD_CLIENT_ID`: Go back to the [Discord Developer Portal](https://discord.com/developers/applications), click your application, go to **General Information**, and copy the **Application ID**. You already grabbed this in Step 2!
   * `DISCORD_CLIENT_SECRET`: Go to the **OAuth2** tab on the Discord portal and copy your **Client Secret** from there. You already copied this in Step 2 as well. See, I told you to save it!
   * `AUTH_URL`: Set this to `http://localhost:3000` for local development. Once you actually deploy the web dashboard to Vercel or wherever, change this to your real public URL!

<br/>

---

## Step 8: Final Config and Launch

We're almost done but don't get cocky! Before you start me up, there are two things left:

**1. Create the Discord Roles (MANDATORY)**

Open `config.js` in the main folder and look at the `ROLES` section. You need to go into your **Discord Server Settings → Roles** and manually create every single role listed there with the **EXACT same spelling**, including capitalization! I'm talking about:
- `Iron`, `Bronze`, `Silver`, `Gold`, `Platinum`, `Diamond`, `Master` (prestige roles)
- `Duel Lord`, `Sugar Daddy`, `Sugar Mommy`
- `Gambling`, `True Member`, `Basically Everyone`, `member`
- Your mod role and owner role (check config.js to see what they're named for your server)

If even ONE role is missing or spelled wrong, I'll crash or silently break. Your fault, not mine!

**2. Set Your Owner ID (Optional but Recommended)**

If you want access to owner-only admin commands, go to your `.env` file and fill in `OWNER_ID` with your personal Discord User ID. To get your user ID: open Discord, go to Settings → Advanced, and turn on **Developer Mode**. Then right-click your own name anywhere and click **Copy User ID**.

**Now Launch!**

Okay, FINALLY everything is ready. You already ran `StartBot.bat` once to generate your `.env` file. Now that you filled it out, just double-click `StartBot.bat` again!

That batch file will automatically:
1. Double-check your Node.js dependencies.
2. Check my GitHub for any new updates and download them directly without Git (yes, I built a custom auto-updater, you're welcome!).
3. Launch my core system with a brand new colored terminal so you can actually read the logs without getting a headache! (And I even added a massive TSUN ascii art logo at the top... >///<)

To start the web dashboard at the same time, open a terminal, navigate into the `web` folder, and type:
```bash
npm run dev
```

If the bot console says `Database Connected!` and `Tsun is online`, then... I guess you didn't completely mess it up. B-but don't think I'm impressed or anything! Hmph!

<br/>

---

## Quick Reference: All .env Variables

Fine, I'll make a cheat sheet for you since you'll obviously forget where everything goes. You're welcome.

### Root `.env` file (main bot)

| Variable | Where to get it | Required? |
|---|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal → Bot → Reset Token | **Yes** |
| `MONGO_URI` | MongoDB Atlas → Connect → Drivers | **Yes** |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary Dashboard → Product Environment | **Yes** |
| `CLOUDINARY_API_KEY` | Cloudinary → Settings → API Keys | **Yes** |
| `CLOUDINARY_API_SECRET` | Cloudinary → Settings → API Keys (reveal) | **Yes** |
| `DASHBOARD_PASSWORD` | Make one up yourself | **Yes** (or I lock you out) |
| `SESSION_SECRET` | Keyboard smash 30+ chars | **Yes** (or I crash) |
| `OWNER_ID` | Discord → Settings → Advanced → Developer Mode → right-click yourself | Optional |
| `MAL_CLIENT_ID` | myanimelist.net/apiconfig → Create ID | Optional |

### `web/.env.local` file (web dashboard)

| Variable | Where to get it | Required? |
|---|---|---|
| `MONGODB_URI` | Same connection string as `MONGO_URI` above | **Yes** |
| `AUTH_SECRET` | Keyboard smash 30+ chars | **Yes** |
| `DISCORD_CLIENT_ID` | Discord Developer Portal → General Information → Application ID | **Yes** |
| `DISCORD_CLIENT_SECRET` | Discord Developer Portal → OAuth2 → Client Secret | **Yes** |
| `AUTH_URL` | `http://localhost:3000` for local, your domain for production | **Yes** |

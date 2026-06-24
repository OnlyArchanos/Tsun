<div align="center">
  <img src="https://i.ibb.co/hxvV5kjn/Cm.png" alt="Megumin" width="300" />
  
  <h1>💖 Tsun Bot</h1>
  <p><i>It's not like I wanted you to host me or anything, baka!</i></p>
</div>

Hmph! So you actually want to set me up? I guess I can explain it to you since you'd probably mess it up otherwise. Don't get the wrong idea! I'm only doing this so you don't break my code. 

Listen closely, idiot, because I'm only going to say this once. You need to set up the Discord Bot *and* the Web Dashboard. Pay attention!

<br/>

<div align="center">
  <img src="https://i.ibb.co/FqDbBcZq/Dm.png" alt="Megumin Smug" width="150" />
</div>

## Step 1: Getting the Boring Stuff

First of all, you need Node.js and Git. If you don't have them, what are you even doing? 
Go download Node.js (v18 or higher) and Git right now. 

Once you have those, open your terminal and type this. Don't make any typos!

```bash
git clone <your-repo-link>
cd tsun
npm install
```

Okay? Now your bot has its packages. We still need to do the web dashboard too, so type this:

```bash
cd web
npm install
cd ..
```

<br/>

## Step 2: The Discord Portal (Pay Attention!)

I need a body to control, obviously! Go to the [Discord Developer Portal](https://discord.com/developers/applications) and log in.

1. Click **New Application** in the top right. Give me a decent name.
2. Go to the **Bot** tab on the left.
3. Scroll down to **Privileged Gateway Intents**. You **HAVE** to turn on **Server Members Intent** and **Message Content Intent**. If you forget this, I'll literally ignore everyone. Your fault! Save the changes.
4. Go up to the **Token** section, click **Reset Token**, and copy the long password. **DO NOT SHOW THIS TO ANYONE!** Are you crazy? If someone steals it, they steal me!
5. Now, go into my folder, find `.env.example`, rename it to `.env`, and paste that token next to `DISCORD_TOKEN=`.

To invite me to your server, go to **OAuth2 > URL Generator**. Check the `bot` box, then check `Administrator` at the bottom. Copy the link, paste it in your browser, and add me to your server. 

<br/>

<div align="center">
  <img src="https://i.ibb.co/KpbbS35s/Am.png" alt="Megumin Pout" width="150" />
</div>

## Step 3: MongoDB Database

I need somewhere to store all the economy data and stocks. We're using MongoDB Atlas because it's free. 

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) and sign up.
2. Create a new cluster and pick the **M0 Free** one. 
3. Create a Database User. Pick a username and password. **WRITE THE PASSWORD DOWN**, idiot!
4. Under Network Access, choose "Allow Access from Anywhere" or type `0.0.0.0/0`.
5. Go to your Database, click **Connect**, and choose **Drivers** (Node.js).
6. Copy the connection string. It looks like `mongodb+srv://username:password@cluster...`
7. Put it in your `.env` file next to `MONGO_URI=`. Don't forget to replace `<password>` with the password you literally just made.

<br/>

## Step 4: Cloudinary (For Images)

If you want me to process user grids and duel images without Discord yelling at me for file sizes, you need this.

1. Go to [Cloudinary](https://cloudinary.com/users/register_free) and sign up.
2. Look at your Dashboard.
3. Copy your **Cloud Name**, **API Key**, and **API Secret**.
4. Put them in the `.env` file under `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.

<br/>

## Step 5: MyAnimeList API

1. Go to [MyAnimeList API Config](https://myanimelist.net/apiconfig) and log in.
2. Click **Create ID**.
3. App Name: Tsun Bot
4. App Type: Hobbyist
5. Redirect URI: `http://localhost`
6. Click Submit, copy the **Client ID**, and put it in your `.env` file as `MAL_CLIENT_ID`. 

<br/>

<div align="center">
  <img src="https://i.ibb.co/MxjKPDh8/Bm.png" alt="Megumin Magic" width="200" />
</div>

## Step 6: Setting up the Web Dashboard

You thought we were done? Hah! You still have to configure my web interface! 

1. Go into the `web` folder.
2. Copy `.env.local.example` and rename it to `.env.local`.
3. Open it up. You need to fill these out:
   * `MONGODB_URI`: Put the EXACT same MongoDB connection string here from Step 3.
   * `AUTH_SECRET`: Mash your keyboard or use a generator to make a really long random password here. It secures the logins.
   * `DISCORD_CLIENT_ID`: Go back to the Discord Developer Portal (General Information page) and copy your Application ID.
   * `DISCORD_CLIENT_SECRET`: Go to the OAuth2 page on the Discord portal and reset your Client Secret to get a new one. Paste it here.
   * `AUTH_URL`: Leave it as `http://localhost:3000` for now. If you put it on Vercel later, change it to your actual website link!

<br/>

## Step 7: Final Config and Launch

Before you even think about starting me up, open `config.js` in the main folder. Look at the `ROLES`. You actually need to go into your Discord Server Settings and create all those roles with the EXACT same spelling. If you don't, I'm going to crash and complain, and it will be your fault.

Okay, everything is finally ready. 

To start the bot, open a terminal in the main folder and type:
```bash
npm start
```

To start the web dashboard, open another terminal, go into the `web` folder, and type:
```bash
npm run dev
```

If it says `🚀 Tsun is online`, then... I guess you did an okay job. B-but don't expect me to praise you or anything! Just go use the bot!

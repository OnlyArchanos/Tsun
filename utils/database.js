const mongoose = require('mongoose');
require('dotenv').config();

// Define the function
async function connectDB() {
    try {
        console.log("⌛ Connecting to MongoDB...");
        mongoose.set('strictQuery', false);
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ Database Connected!");
    } catch (err) {
        console.error("❌ DB Error:", err.message);
        process.exit(1);
    }
}

// Export the function directly
module.exports = connectDB;
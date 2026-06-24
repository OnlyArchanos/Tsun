const cloudinary = require('cloudinary').v2;
require('dotenv').config();

// Configure Cloudinary with secrets
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadImage = async (filePath, userId) => {
    console.log(`☁️ Uploading image for User ${userId}... Don't rush me!`);
    
    try {
        // Updated: Resize to max 800x800 to save bandwidth/memory
        const result = await cloudinary.uploader.upload(filePath, {
            public_id: `user_grids/${userId}`, 
            overwrite: true,
            transformation: [
                { width: 800, height: 800, crop: "limit" }, // Resize if larger
                { quality: "auto", fetch_format: "auto" }   // Optimize size
            ]
        });
        
        console.log(`✅ Upload success! URL: ${result.secure_url} (Hmph, you're welcome.)`);
        return result.secure_url;

    } catch (error) {
        console.error("❌ Cloudinary Upload Error: Ugh, the cloud is being stupid!", error);
        throw error; 
    }
};

module.exports = { uploadImage };
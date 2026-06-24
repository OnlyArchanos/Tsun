/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  serverExternalPackages: ['mongoose'],
};

export default nextConfig;

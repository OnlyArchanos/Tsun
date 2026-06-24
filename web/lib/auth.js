import NextAuth from 'next-auth';
import Discord from 'next-auth/providers/discord';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      // On initial sign-in, persist the Discord user ID into the JWT
      if (account && profile) {
        token.discordId = profile.id;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose discordId on the client-side session
      session.user.discordId = token.discordId;
      return session;
    },
  },
});

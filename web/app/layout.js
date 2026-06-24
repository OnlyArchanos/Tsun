import { Inter } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Providers from "@/components/Providers";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata = {
  title: "TsunStocks — Trade Your Friends",
  description:
    "A stock market game where Discord users buy and sell shares of each other. Track prices, build your portfolio, and climb the leaderboard.",
  keywords: ["stock market", "discord", "trading game", "TsunStocks"],
  openGraph: {
    title: "TsunStocks — Trade Your Friends",
    description:
      "A stock market game where Discord users buy and sell shares of each other.",
    type: "website",
  },
};

export const viewport = {
  themeColor: "#0a0a0f",
  colorScheme: "dark",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Providers>
          <Navbar />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}

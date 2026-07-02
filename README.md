# 🎤 KaraokeParty — Real-Time Vocal Scoring App

Welcome to **KaraokeParty**, the ultimate web-based karaoke platform designed to turn any gathering into a live singing competition. Sing your favorite tracks, get real-time vocal pitch feedback, and challenge friends to beat your high score!

🌐 **Live Website:** [karaokeparty.in](https://karaokeparty.in)

---

## 🚀 Core Features

*   🎯 **Real-Time Pitch Scoring:** Uses the browser's Web Audio API to track your vocal performance and score your accuracy live as you sing.
*   🔍 **Instant Music Search:** High-performance, low-latency track discovery powered by a custom cloud backend engine.
*   🔐 **Secure Google Authentication:** Quick login capabilities to securely save your high scores, track your singing history, and manage your profile.
*   📱 **Zero-Installation Experience:** Optimized web application requiring no heavy downloads or plug-ins—fully responsive across desktops, tablets, and smartphones.

---

## 🛠️ Tech Stack

### Frontend & UI
*   **Framework:** React 18 with TypeScript
*   **Build Tool:** Vite
*   **Styling:** Tailwind CSS + shadcn/ui components
*   **Deployment:** GitHub Pages / Custom Domain Routing

### Backend & Cloud Services
*   **Database & Auth:** Supabase (PostgreSQL)
*   **Authentication Provider:** Google OAuth
*   **Serverless Architecture:** Supabase Edge Functions (`search-music`)

---

## 💻 Local Development Setup

If you want to pull this project down to work on it locally inside your preferred IDE, ensure you have **Node.js & npm** installed.

### Step 1: Clone the Repository
```sh
git clone [https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME.git](https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME.git)
<img width="1920" height="1020" alt="image" src="https://github.com/user-attachments/assets/d4967e42-2e98-4343-94d9-d6a20171ac99" />


# 🦉 Hoots Music

### A modern, self-hosted music streaming platform built for the web.

Hoots Music is a lightweight music streaming web application with a **PWA frontend** and **FastAPI backend**. It combines a clean glassmorphism interface with authentication, music search, playlists, streaming, and an admin system.

> 🎧 **Search. Discover. Listen. Repeat.**

---

## ✨ Features

### 🎵 Music Experience

* 🔎 Music search
* ▶️ Instant playback
* ⏯️ Play / Pause controls
* ⏭️ Next / Previous track controls
* 🎚️ Seekable playback bar
* 🔊 Persistent bottom music player
* 🦉 Animated owl-eye equalizer while music is playing

### 📚 Playlists

* Create personal playlists
* Add songs to playlists
* Browse playlists
* Play songs directly from playlists

### 🔐 Authentication

* Email & password signup
* Email & password login
* Google OAuth login
* JWT-based authentication
* Persistent login sessions
* User profile information
* Role-based access control

### 🛡️ Admin System

Admin users can:

* Manage users
* Ban / unban users
* Configure advertisement settings
* Set daily advertisement limits
* Control advertisement type

### 📱 Progressive Web App

Hoots Music is built as an installable PWA.

It can be installed on:

* 🖥️ Windows
* 💻 macOS
* 📱 Android
* 🍎 iOS

The frontend uses a service worker to cache the application shell for a faster experience.

---

## 🎨 Design

Hoots Music uses a custom dark music-player interface featuring:

* 🌑 Dark UI
* 🪟 Glassmorphism
* 🟣 Violet glow effects
* 🦉 Owl-inspired branding
* 🎵 Minimal music-player controls
* 📱 Responsive layout
* ✨ Animated playback indicators

The signature **owl-eye equalizer** reacts while music is playing.

---

## 🏗️ Architecture

```text
                    ┌─────────────────────┐
                    │     Hoots Music     │
                    │      Frontend       │
                    │  HTML / CSS / JS    │
                    └──────────┬──────────┘
                               │
                               │ REST API
                               ▼
                    ┌─────────────────────┐
                    │   FastAPI Backend   │
                    │      Python         │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐     ┌──────────┐     ┌──────────┐
        │ MongoDB  │     │   Auth   │     │  Music   │
        │ Database │     │ JWT/OAuth│     │ Services │
        └──────────┘     └──────────┘     └──────────┘
```

---

## 📁 Project Structure

```text
hoots-music/
│
├── hoots-music-backend/
│   │
│   ├── app/
│   │   ├── main.py
│   │   ├── auth.py
│   │   └── ...
│   │
│   ├── requirements.txt
│   └── README.md
│
├── hoots-music-frontend/
│   │
│   ├── css/
│   ├── icons/
│   ├── js/
│   ├── index.html
│   ├── manifest.json
│   ├── service-worker.js
│   └── README.md
│
└── README.md
```

---

# 🚀 Getting Started

## 1. Clone the repository

```bash
git clone https://github.com/sunnyptl95/hoots-music-PWA.git

cd hoots-music
```

---

# ⚙️ Backend Setup

Go to the backend directory:

```bash
cd hoots-music-backend
```

Create a virtual environment:

### Windows

```bash
python -m venv venv
venv\Scripts\activate
```

### Linux / macOS

```bash
python3 -m venv venv
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

---

## 🔑 Environment Variables

Create a `.env` file inside the backend directory.

Example:

```env
MONGO_URI=your_mongodb_connection_string

JWT_SECRET=your_long_random_secret

JWT_EXPIRE_MINUTES=10080

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback

FRONTEND_URL=http://localhost:3000

FIRST_ADMIN_EMAIL=your_email@example.com
```

### MongoDB

Hoots Music uses MongoDB for storing application data.

You can use:

* MongoDB Atlas
* Local MongoDB

---

## ▶️ Start the Backend

Run:

```bash
uvicorn app.main:app --reload
```

The API will be available at:

```text
http://localhost:8000
```

Interactive API documentation:

```text
http://localhost:8000/docs
```

---

# 🌐 Frontend Setup

Open another terminal:

```bash
cd hoots-music-frontend
```

Update the API URL inside:

```text
js/app.js
```

Example:

```javascript
const API_BASE = "http://localhost:8000";
```

Then start a local HTTP server:

```bash
python -m http.server 3000
```

Open:

```text
http://localhost:3000
```

> ⚠️ Don't open `index.html` directly using `file://`. The PWA service worker requires an HTTP/HTTPS origin.

---

# 🔐 Authentication API

Current authentication endpoints include:

| Method | Endpoint                | Description      |
| ------ | ----------------------- | ---------------- |
| `POST` | `/auth/signup`          | Create account   |
| `POST` | `/auth/login`           | Login            |
| `POST` | `/auth/logout`          | Logout           |
| `GET`  | `/auth/me`              | Get current user |
| `GET`  | `/auth/google`          | Google OAuth     |
| `GET`  | `/auth/google/callback` | OAuth callback   |

Authentication uses **JWT sessions**, while passwords are securely hashed using bcrypt.

---

# 🎧 Frontend Functionality

The frontend currently provides:

```text
Authentication
      │
      ▼
    Home
      │
      ├── Search
      │     └── Play music
      │
      ├── Playlists
      │     ├── Create playlist
      │     └── Add songs
      │
      └── Music Player
             ├── Play / Pause
             ├── Previous
             ├── Next
             └── Seek
```

The player remains available through the persistent bottom player bar.

---

# 📱 Install Hoots Music

Once the frontend is deployed using HTTPS, Hoots Music can be installed as a Progressive Web App.

### Desktop

Open the website in Chrome or Edge and select:

```text
Install Hoots Music
```

### Android

Open the website in Chrome:

```text
Menu → Add to Home Screen
```

### iOS

Open the website in Safari:

```text
Share → Add to Home Screen
```

---

# ☁️ Deployment

The frontend can be deployed on static hosting services such as:

* Netlify
* Vercel
* Render

The FastAPI backend can be deployed on a Python-compatible hosting platform.

For production deployment, update:

```env
FRONTEND_URL=https://your-frontend-domain.com
```

and configure the Google OAuth redirect URI accordingly.

---

# 🗺️ Development Roadmap

Hoots Music is being developed in phases.

### Phase 1 — Foundation

* [x] Frontend
* [x] PWA support
* [x] Authentication
* [x] JWT sessions
* [x] Google OAuth
* [x] MongoDB integration
* [x] User roles
* [x] Basic admin system

### Phase 2 — Music

* [x] Music search
* [x] Music playback
* [x] Streaming integration
* [x] Persistent player
* [x] Playlists

### Phase 3 — Platform

* [ ] Better recommendations
* [ ] Listening history
* [ ] User profiles
* [ ] Improved playlist management
* [ ] Advanced admin dashboard
* [ ] Better caching
* [ ] Performance optimization

### Phase 4 — Hoots Ecosystem

* [ ] Mobile-focused improvements
* [ ] Advanced music discovery
* [ ] Personalized recommendations
* [ ] More powerful playlist tools
* [ ] Improved PWA capabilities
* [ ] More customization

---

# 🛡️ Security

Hoots Music is designed with several security mechanisms:

* JWT authentication
* Password hashing with bcrypt
* Role-based authorization
* Protected admin routes
* Environment-based secrets
* OAuth authentication
* Session tracking

**Never commit your `.env` file or API credentials to GitHub.**

---

# 🤝 Contributing

Contributions, ideas, bug reports, and improvements are welcome.

### Fork the repository

```bash
git fork https://github.com/sunnyptl95/hoots-music
```

Create a branch:

```bash
git checkout -b feature/your-feature
```

Make your changes and commit:

```bash
git add .
git commit -m "Add your feature"
```

Push:

```bash
git push origin feature/your-feature
```

Then open a Pull Request.

---

# 📄 License

License information will be added as the project reaches its stable release.

---

# 🦉 About Hoots Music

Hoots Music is an independent music platform project focused on building a modern, lightweight and customizable music experience for the web.

Built with ❤️ and ☕ by **Sunny**.

---

<p align="center">

### 🦉 Hoots Music

**Your music. Your playlists. Your experience.**

⭐ Star the repository if you like the project!

</p>

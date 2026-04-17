# Setup

## 1. GitHub Token (GH_TOKEN)

Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
Create a token with read access to your repos (needed for language stats and commit count).

Add it as a repository secret: `Settings → Secrets → Actions → New repository secret`
Name: `GH_TOKEN`

> The default `GITHUB_TOKEN` works for pushing commits, but a PAT is needed
> to read commit counts across all your repositories via the Search API.

---

## 2. Spotify (optional)

If you skip this, the script shows "nothing playing" and still works fine.

### Step 1 — Create a Spotify app

1. Go to https://developer.spotify.com/dashboard
2. Create an app — set Redirect URI to `http://localhost:3000/callback`
3. Copy your **Client ID** and **Client Secret**

### Step 2 — Get your refresh token

Run this in your terminal (replace the placeholders):

```bash
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret

# 1. Open this URL in your browser and authorize:
echo "https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=http://localhost:3000/callback&scope=user-read-currently-playing%20user-read-recently-played"

# 2. After you authorize, you'll be redirected to localhost:3000/callback?code=XXXX
#    Copy that XXXX code, then run:

CODE=paste_code_here

curl -X POST https://accounts.spotify.com/api/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -d "grant_type=authorization_code&code=${CODE}&redirect_uri=http://localhost:3000/callback"

# Response will contain "refresh_token" — copy that value.
```

### Step 3 — Add secrets

Add three repository secrets:
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`

---

## 3. First run

After pushing all files:

1. Go to **Actions** tab in your repo
2. Select **Update profile SVG**
3. Click **Run workflow**

The `user.svg` will be committed to the repo and your profile will update.
From then on it runs automatically every hour.

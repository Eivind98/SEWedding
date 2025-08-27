# WeddingProject

Simple static wedding info site.

## Local preview
Just open `index.html` in a browser (double click) or run a tiny local server:

```bash
# Python 3
python -m http.server 8000
```

## Deploying on CapRover
Because this is a static site, the simplest approach is to serve it with an Nginx container.

### 1. Create a new app in CapRover
In the CapRover dashboard, click **+ Create New App**. Give it an app name, keep the defaults.

### 2. Add a simple `Dockerfile`
This repo already contains a `Dockerfile` that uses a lightweight Nginx image.

### 3. Deploy via CLI
Install the CapRover CLI if you haven't:

```bash
npm install -g caprover
```

Login and deploy:

```bash
caprover login -n <your-caprover-domain>
# follow prompts
caprover deploy -t . -a <app-name>
```

Alternatively, push to the CapRover git remote created during app setup.

### 4. Set as static site (optional)
For pure static content you can also skip Dockerfile and use the built-in one-click static site template; but having a Dockerfile gives full control.

### 5. Configure HTTPS & domain
Use CapRover dashboard to set a custom domain and enable HTTPS (Let's Encrypt).

---

## Customization
Edit `index.html`, `style.css`, and `script.js` as needed. Replace Unsplash images with your own for production.

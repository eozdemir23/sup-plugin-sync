import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import https from 'https';
import ora from 'ora';
import chalk from 'chalk';
import readline from 'readline';

// --- YARDIMCI FONKSİYONLAR ---

// Git yüklü mü kontrol et
function isGitInstalled() {
    try { execSync('git --version', { stdio: 'ignore' }); return true; } catch { return false; }
}

// Token'ı kaydet/oku (Config yönetimi)
const CONFIG_FILE = path.join(process.cwd(), '.sup-config.json');

function saveToken(token) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ github_token: token }, null, 2));
}

function getToken() {
    if (fs.existsSync(CONFIG_FILE)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return config.github_token;
    }
    return null;
}

// Terminalden giriş al (Token sormak için)
function askQuestion(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

// GitHub API İsteği
async function githubApi(method, endpoint, token, data) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: endpoint,
            method: method,
            headers: {
                'Authorization': `token ${token}`,
                'User-Agent': 'SUP-CLI-Hybrid-Sync',
                'Content-Type': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(body || '{}'));
                else reject(new Error(res.statusCode === 401 ? "Geçersiz Token!" : "API Hatası"));
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

// --- ANA AKIŞ ---

export async function run(sup, args) {
    const repoUrl = args[0]; // Kullanım: sup sync eozdemir23/repo-adi
    if (!repoUrl) return console.log(chalk.red("❌ Hata: Kullanici/Repo belirtmelisiniz."));

    if (isGitInstalled()) {
        // --- 1. SENARYO: GİT VAR (Normal Akış) ---
        const spinner = ora('Git ile senkronize ediliyor...').start();
        try {
            if (!fs.existsSync('.git')) execSync('git init', { stdio: 'ignore' });
            try { execSync(`git remote add origin https://github.com/${repoUrl}.git`, { stdio: 'ignore' }); } catch {
                execSync(`git remote set-url origin https://github.com/${repoUrl}.git`, { stdio: 'ignore' });
            }
            execSync('git add .', { stdio: 'ignore' });
            execSync(`git commit -m "SUP-Sync: ${new Date().toLocaleString()}"`, { stdio: 'ignore' });
            execSync('git push -u origin main', { stdio: 'ignore' });
            spinner.succeed(chalk.green("✅ Git ile başarıyla push edildi."));
        } catch (e) {
            spinner.fail(chalk.red("Git işlemi başarısız. Yetki hatası olabilir."));
        }
    } else {
        // --- 2. SENARYO: GİT YOK (API Akışı) ---
        console.log(chalk.yellow("⚠️  Sistemde Git bulunamadı. GitHub API moduna geçiliyor..."));

        let token = getToken();
        if (!token) {
            token = await askQuestion(chalk.cyan("🔑 GitHub Personal Access Token girin: "));
            const checkSpinner = ora('Token doğrulanıyor...').start();
            try {
                await githubApi('GET', '/user', token);
                checkSpinner.succeed(chalk.green("Token doğrulandı ve kaydedildi."));
                saveToken(token);
            } catch (e) {
                checkSpinner.fail(chalk.red("Hata: " + e.message));
                return;
            }
        }

        const syncSpinner = ora('Dosyalar API üzerinden yükleniyor...').start();
        try {
            const files = getAllFiles(process.cwd());
            for (const file of files) {
                const relPath = path.relative(process.cwd(), file).replace(/\\/g, '/');
                if (relPath.includes('node_modules') || relPath.startsWith('.git') || relPath === '.sup-config.json') continue;

                const content = fs.readFileSync(file, { encoding: 'base64' });
                let sha;
                try {
                    const info = await githubApi('GET', `/repos/${repoUrl}/contents/${relPath}`, token);
                    sha = info.sha;
                } catch {}

                await githubApi('PUT', `/repos/${repoUrl}/contents/${relPath}`, token, {
                    message: `SUP-API-Sync: ${relPath}`,
                    content: content,
                    sha: sha
                });
            }
            syncSpinner.succeed(chalk.green("✅ API üzerinden başarıyla senkronize edildi."));
        } catch (e) {
            syncSpinner.fail(chalk.red("API hatası: " + e.message));
        }
    }
}

function getAllFiles(dir, files = []) {
    fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) getAllFiles(p, files);
        else files.push(p);
    });
    return files;
}

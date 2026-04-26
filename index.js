import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import https from 'https';
import ora from 'ora';
import chalk from 'chalk';
import readline from 'readline';

// --- SABİTLER ---
const IGNORED_PATHS = [
    'node_modules', '.git', '.sup-config.json',
    '.env', '.env.local', 'dist', 'build', '.cache',
    'package-lock.json', '.DS_Store', 'Thumbs.db'
];

const CONFIG_FILE = path.join(process.cwd(), '.sup-config.json');

// --- YARDIMCI FONKSİYONLAR ---

function isGitInstalled() {
    try { execSync('git --version', { stdio: 'ignore' }); return true; } catch { return false; }
}

function saveConfig(data) {
    let existing = {};
    if (fs.existsSync(CONFIG_FILE)) {
        try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, ...data }, null, 2));
}

function getConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
    }
    return {};
}

function askQuestion(query, hidden = false) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        if (hidden) {
            process.stdout.write(query);
            process.stdin.setRawMode?.(true);
            let input = '';
            process.stdin.once('data', (data) => {
                input = data.toString().trim();
                process.stdout.write('\n');
                process.stdin.setRawMode?.(false);
                rl.close();
                resolve(input);
            });
        } else {
            rl.question(query, ans => { rl.close(); resolve(ans.trim()); });
        }
    });
}

// GitHub API isteği (retry desteğiyle)
async function githubApi(method, endpoint, token, data, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const body = data ? JSON.stringify(data) : null;
                const options = {
                    hostname: 'api.github.com',
                    path: endpoint,
                    method: method,
                    headers: {
                        'Authorization': `token ${token}`,
                        'User-Agent': 'SUP-CLI-Sync',
                        'Content-Type': 'application/json',
                        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
                    }
                };
                const req = https.request(options, (res) => {
                    let resBody = '';
                    res.on('data', c => resBody += c);
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(resBody || '{}');
                            if (res.statusCode === 401) reject(new Error("Geçersiz veya süresi dolmuş token!"));
                            else if (res.statusCode === 403) reject(new Error("Yetersiz izin. Token'ın 'repo' iznine sahip olduğundan emin ol."));
                            else if (res.statusCode === 404) reject(new Error("Repo bulunamadı. Repo adını kontrol et."));
                            else if (res.statusCode === 422) resolve(parsed); // Zaten mevcut, sorun değil
                            else if (res.statusCode >= 400) reject(new Error(`API Hatası ${res.statusCode}: ${parsed.message || 'Bilinmeyen hata'}`));
                            else resolve(parsed);
                        } catch { reject(new Error("API yanıtı ayrıştırılamadı.")); }
                    });
                    res.on('error', reject);
                });
                req.on('error', reject);
                if (body) req.write(body);
                req.end();
            });
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); // Exponential backoff
        }
    }
}

// Repo var mı kontrol et, yoksa oluştur
async function ensureRepo(repoUrl, token) {
    const [owner, repo] = repoUrl.split('/');
    try {
        await githubApi('GET', `/repos/${owner}/${repo}`, token);
        return true; // Repo zaten var
    } catch (e) {
        if (e.message.includes('bulunamadı')) {
            // Repo yok, oluştur
            const spinner = ora('Repo bulunamadı, oluşturuluyor...').start();
            try {
                await githubApi('POST', '/user/repos', token, {
                    name: repo,
                    private: false,
                    auto_init: true
                });
                spinner.succeed(chalk.green(`✔ '${repo}' reposu oluşturuldu.`));
                await new Promise(r => setTimeout(r, 1500)); // GitHub'ın repo'yu hazırlaması için bekle
                return true;
            } catch (createErr) {
                spinner.fail(chalk.red(`Repo oluşturulamadı: ${createErr.message}`));
                return false;
            }
        }
        throw e;
    }
}

// Tüm dosyaları recursive olarak topla
function getAllFiles(dir, baseDir = dir, files = []) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return files; }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

        // Görmezden gelinecek yolları kontrol et
        const shouldIgnore = IGNORED_PATHS.some(ignored =>
            relPath === ignored ||
            relPath.startsWith(ignored + '/') ||
            entry === ignored
        );
        if (shouldIgnore) continue;

        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) getAllFiles(fullPath, baseDir, files);
            else if (stat.size < 10 * 1024 * 1024) files.push(fullPath); // 10MB limit
        } catch {}
    }
    return files;
}

// Mevcut branch adını güvenli şekilde al
function getCurrentBranch() {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }).toString().trim();
    } catch {
        return 'main'; // Varsayılan
    }
}

// Git ile sync (token'ı URL'e göm)
function syncWithGit(repoUrl, token, message) {
    const remoteUrl = token
        ? `https://${token}@github.com/${repoUrl}.git`
        : `https://github.com/${repoUrl}.git`;

    if (!fs.existsSync('.git')) execSync('git init', { stdio: 'ignore' });

    try {
        execSync(`git remote add origin "${remoteUrl}"`, { stdio: 'ignore' });
    } catch {
        execSync(`git remote set-url origin "${remoteUrl}"`, { stdio: 'ignore' });
    }

    // Git kullanıcı ayarları yoksa geçici olarak ekle
    try { execSync('git config user.email', { stdio: 'ignore' }); } catch {
        execSync('git config user.email "sup-cli@sync.local"', { stdio: 'ignore' });
    }
    try { execSync('git config user.name', { stdio: 'ignore' }); } catch {
        execSync('git config user.name "SUP CLI"', { stdio: 'ignore' });
    }

    execSync('git add .', { stdio: 'ignore' });

    // Commit et (değişiklik yoksa hata verme)
    try {
        execSync(`git commit -m "${message}"`, { stdio: 'ignore' });
    } catch {
        // Commit edilecek değişiklik yok, push yine de dene
    }

    const branch = getCurrentBranch();
    execSync(`git push -u origin ${branch}`, { stdio: 'ignore' });
    return branch;
}

// --- ANA AKIŞ ---

export async function run(sup, args) {
    const repoUrl = args[0];

    if (!repoUrl || !repoUrl.includes('/')) {
        console.log(chalk.red("❌ Hata: Kullanım: sup sync <kullanici>/<repo>"));
        console.log(chalk.gray("   Örnek: sup sync eozdemir23/projem"));
        return;
    }

    const commitMessage = args.slice(1).join(' ') || `SUP-Sync: ${new Date().toLocaleString('tr-TR')}`;
    const config = getConfig();
    let token = config.github_token || null;

    console.log(chalk.cyan.bold(`\n🔄 SUP Sync → github.com/${repoUrl}\n`));

    // Token kontrolü
    if (!token) {
        console.log(chalk.yellow("⚠️  GitHub token bulunamadı."));
        console.log(chalk.gray("   Token almak için: github.com → Settings → Developer settings → Personal access tokens\n"));
        token = await askQuestion(chalk.cyan("🔑 GitHub Personal Access Token: "));

        if (!token) {
            console.log(chalk.red("❌ Token girilmedi, işlem iptal edildi."));
            return;
        }

        const verifySpinner = ora('Token doğrulanıyor...').start();
        try {
            const user = await githubApi('GET', '/user', token);
            verifySpinner.succeed(chalk.green(`✔ Token doğrulandı. Hoş geldin, ${user.login}!`));
            saveConfig({ github_token: token });
        } catch (e) {
            verifySpinner.fail(chalk.red(`Token geçersiz: ${e.message}`));
            return;
        }
    }

    if (isGitInstalled()) {
        // --- GİT MODU ---
        const spinner = ora('Git ile senkronize ediliyor...').start();
        try {
            const branch = syncWithGit(repoUrl, token, commitMessage);
            spinner.succeed(chalk.green(`✔ '${branch}' branch'i başarıyla push edildi → github.com/${repoUrl}`));
        } catch (e) {
            spinner.fail(chalk.red(`Git işlemi başarısız: ${e.message}`));

            // Git başarısız olursa API moduna geç
            console.log(chalk.yellow("\n⚡ API moduna geçiliyor...\n"));
            await syncViaApi(repoUrl, token, commitMessage);
        }
    } else {
        // --- API MODU ---
        console.log(chalk.yellow("⚠️  Git bulunamadı. GitHub API modu kullanılıyor...\n"));
        await syncViaApi(repoUrl, token, commitMessage);
    }
}

async function syncViaApi(repoUrl, token, commitMessage) {
    // Repo var mı kontrol et, yoksa oluştur
    const repoExists = await ensureRepo(repoUrl, token);
    if (!repoExists) return;

    const files = getAllFiles(process.cwd());
    if (files.length === 0) {
        console.log(chalk.yellow("⚠️  Gönderilecek dosya bulunamadı."));
        return;
    }

    console.log(chalk.gray(`📁 ${files.length} dosya yüklenecek...\n`));

    const spinner = ora(`Dosyalar yükleniyor (0/${files.length})...`).start();
    let success = 0, failed = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relPath = path.relative(process.cwd(), file).replace(/\\/g, '/');

        spinner.text = `Yükleniyor: ${relPath} (${i + 1}/${files.length})`;

        try {
            let content;
            try {
                content = fs.readFileSync(file, { encoding: 'base64' });
            } catch {
                failed++;
                continue;
            }

            // Mevcut dosyanın SHA'sını al (güncelleme için gerekli)
            let sha;
            try {
                const info = await githubApi('GET', `/repos/${repoUrl}/contents/${relPath}`, token);
                sha = info.sha;
            } catch {}

            await githubApi('PUT', `/repos/${repoUrl}/contents/${relPath}`, token, {
                message: `${commitMessage} [${relPath}]`,
                content,
                ...(sha ? { sha } : {})
            });

            success++;
        } catch (e) {
            failed++;
            // Sessizce geç, tüm süreci durdurma
        }
    }

    if (failed === 0) {
        spinner.succeed(chalk.green(`✔ ${success} dosya başarıyla yüklendi → github.com/${repoUrl}`));
    } else {
        spinner.warn(chalk.yellow(`⚠️  ${success} başarılı, ${failed} başarısız → github.com/${repoUrl}`));
    }
}

export function verify() {
    return "!1qaz2WSX3edc4RFV%56";
}

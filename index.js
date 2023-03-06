const path = require("path")
const child_process = require("child_process")
const fs = require("fs")
const readPkgUp = require("read-pkg-up")
const rimraf = require("rimraf")
const globby = require("globby")
const checksum = require("checksum")
const merge = require("lodash/merge")
const debounce = require("lodash/debounce")
const {spawn} = require("yarn-or-npm")
const tar = require("tar")

async function installRelativeDeps(skipBuild) {
    const projectPkgJson = readPkgUp.sync()

    const relativeDependencies = projectPkgJson.package.relativeDependencies

    if (!relativeDependencies) {
        console.warn("\x1b[33m[relative-deps]\x1b[0m[WARN] No 'relativeDependencies' specified in package.json")
        process.exit(0)
    }

    const targetDir = path.dirname(projectPkgJson.path)

    const depNames = Object.keys(relativeDependencies)
    for (const name of depNames) {
        const libDir = path.resolve(targetDir, relativeDependencies[name])
        console.log(`\x1b[33m[relative-deps]\x1b[0m Checking '${name}' in '${libDir}'`)

        const regularDep =
            (projectPkgJson.package.dependencies && projectPkgJson.package.dependencies[name]) ||
            (projectPkgJson.package.devDependencies && projectPkgJson.package.devDependencies[name])

        if (!regularDep) {
            console.warn(`\x1b[33m[relative-deps]\x1b[0m[WARN] The relative dependency '${name}' should also be added as normal- or dev-dependency`)
        }

        // Check if target dir exists
        if (!fs.existsSync(libDir)) {
            // Nope, but is the dependency mentioned as normal dependency in the package.json? Use that one
            if (regularDep) {
                console.warn(`\x1b[33m[relative-deps]\x1b[0m[WARN] Could not find target directory '${libDir}', using normally installed version ('${regularDep}') instead`)
                return
            } else {
                console.error(
                    `\x1b[33m[relative-deps]\x1b[0m[ERROR] Failed to resolve dependency ${name}: failed to find target directory '${libDir}', and the library is not present as normal depenency either`
                )
                process.exit(1)
            }
        }

        const hashStore = {
            hash: "",
            file: ""
        }
        const hasChanges = await libraryHasChanged(name, libDir, targetDir, hashStore)
        if (hasChanges) {
            if (!skipBuild) {
                buildLibrary(name, libDir)
            }
            await packAndInstallLibrary(name, libDir, targetDir)
            fs.writeFileSync(hashStore.file, hashStore.hash)
            console.log(`\x1b[33m[relative-deps]\x1b[0m Re-installing ${name}... DONE`)
        }
        return hasChanges
    }
}

let existingProcess = undefined
let buildWatchProcess = undefined
let cpxWatchProcess = undefined
let proxyProcess = undefined
let apiProcess = undefined
let backofficeProcess = undefined
let obsoleteProcesses = []

async function installRelativeDepsWithNext() {
    const startMs = new Date()
    const reloaded = await installRelativeDeps(true)
    if (reloaded) {
        if (existingProcess) {
            obsoleteProcesses.push(existingProcess)
        }
        obsoleteProcesses.forEach(p => p.kill())
        await removeNextCache()
        console.log(`\x1b[33m[relative-deps]\x1b[0m Reloading next dev evironment`)
        startDevelopmentProcess()
        console.log(`\x1b[33m[relative-deps]\x1b[0m Reloading next dev evironment... DONE`)
        console.log(`\x1b[33m[relative-deps]\x1b[0m Ready after ${(new Date().valueOf() - startMs.valueOf()) / 1000}s`)
    }
}

async function removeNextCache() {
    try {
        if (fs.existsSync(".next")) {
            console.log(`\x1b[33m[relative-deps]\x1b[0m Removing next cache`)
            await rimraf(".next", {preserveRoot: true})
        }
    } catch (err) {
        return await removeNextCache()
    }
}

async function watchRelativeDeps() {
    const projectPkgJson = readPkgUp.sync()

    const relativeDependencies = projectPkgJson.package.relativeDependencies

    if (!relativeDependencies) {
        console.warn("\x1b[33m[relative-deps]\x1b[0m[WARN] No 'relativeDependencies' specified in package.json")
        process.exit(0)
    }

    Object.values(relativeDependencies).forEach(path => {
        fs.watch(path, {recursive: true}, debounce(installRelativeDeps, 500))
    });
}

function startDevelopmentProcess() {
    existingProcess = spawn(["run", "dev"], {cwd: process.cwd()})
    hookStdio(existingProcess, `npm run dev`);
}

function startApiProcess(dir) {
    const libraryPkgJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    console.log("Reading file", path.join(dir, "package.json"))
    if (libraryPkgJson.scripts && libraryPkgJson.scripts["dev:express"]) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m Running 'dev:express' in ${dir}`)
        apiProcess = spawn(["run", "dev:express"], {cwd: dir})
        hookStdio(apiProcess, `${name}:npm dev:express`);
    } else {
        console.log("dev:express script not found")
    }
}

function startProxyProcess(dir) {
    const libraryPkgJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    console.log("Reading file", path.join(dir, "package.json"))
    if (libraryPkgJson.scripts && libraryPkgJson.scripts["dev:proxy"]) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m Running 'dev:proxy' in ${dir}`)
        proxyProcess = spawn(["run", "dev:proxy"], {cwd: dir})
        hookStdio(proxyProcess, `${name}:npm dev:proxy`);
    } else {
        console.log("dev:proxy script not found")
    }
}

async function watchRelativeDepsWithNext() {
    const projectPkgJson = readPkgUp.sync()

    const relativeDependencies = projectPkgJson.package.relativeDependencies

    if (!relativeDependencies) {
        console.warn("\x1b[33m[relative-deps]\x1b[0m[WARN] No 'relativeDependencies' specified in package.json")
        process.exit(0)
    }

    if (fs.existsSync(".next")) {
        await rimraf(".next", {preserveRoot: true})
    }
    await installRelativeDeps()
    startDevelopmentProcess();

    Object.keys(relativeDependencies).forEach(p => {
        console.log(projectPkgJson.path, p, relativeDependencies, relativeDependencies[p])
        const targetDir = path.dirname(projectPkgJson.path)
        const name = p;
        const libDir = path.resolve(targetDir, relativeDependencies[name])
        buildAndWatchNextLibrary(name, libDir)
        const watchDir = path.join(libDir, "dist")
        console.log(`Watching ${watchDir}`)
        fs.watch(
            watchDir,
            {recursive: true},
            debounce(installRelativeDepsWithNext, 300)
        )
    });
}

async function watchRelativeDepsNewArch() {
    const projectPkgJson = readPkgUp.sync()

    const relativeDependencies = projectPkgJson.package.relativeDependencies

    if (!relativeDependencies) {
        console.warn("\x1b[33m[relative-deps]\x1b[0m[WARN] No 'relativeDependencies' specified in package.json")
        process.exit(0)
    }

    if (fs.existsSync(".next")) {
        await rimraf(".next", {preserveRoot: true})
    }
    await installRelativeDeps()
    startDevelopmentProcess();

    Object.keys(relativeDependencies).forEach(p => {
        console.log(projectPkgJson.path, p, relativeDependencies, relativeDependencies[p])
        const targetDir = path.dirname(projectPkgJson.path)
        const name = p;
        const libDir = path.resolve(targetDir, relativeDependencies[name])

        startApiProcess(libDir);
        startProxyProcess(libDir);
        // startBackofficeProcess(libdir);

        buildAndWatchNextLibrary(name, libDir)
        const watchDir = path.join(libDir, "dist")
        console.log(`Watching ${watchDir}`)
        fs.watch(
            watchDir,
            {recursive: true},
            debounce(installRelativeDepsWithNext, 300)
        )
    });
}

async function libraryHasChanged(name, libDir, targetDir, hashStore) {
    const hashFile = path.join(targetDir, "node_modules", name, ".relative-deps-hash")
    const referenceContents = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf8") : ""
    // compute the hahses
    const distLibFiled = path.join(libDir, 'dist')
    const libFiles = await findFiles(distLibFiled, targetDir)
    const hashes = []
    for (file of libFiles) hashes.push(await getFileHash(path.join(distLibFiled, file)))
    const contents = libFiles.map((file, index) => hashes[index] + " " + file).join("\n")
    hashStore.file = hashFile
    hashStore.hash = contents
    if (contents === referenceContents) {
        // computed hashes still the same?
        console.log("\x1b[33m[relative-deps]\x1b[0m No changes")
        return false
    }
    // Print which files did change
    if (referenceContents) {
        const contentsLines = contents.split("\n")
        const refLines = referenceContents.split("\n")
        for (let i = 0; i < contentsLines.length; i++)
            if (contentsLines[i] !== refLines[i]) {
                console.log("\x1b[33m[relative-deps]\x1b[0m Changed file: " + libFiles[i]) //, contentsLines[i], refLines[i])
                break
            }
    }
    return true
}

async function findFiles(libDir, targetDir) {
    const ignore = ["**/*", "!node_modules", "!.git"]
    // TODO: use resolved paths here
    if (targetDir.indexOf(libDir) === 0) {
        // The target dir is in the lib directory, make sure that path is excluded
        ignore.push("!" + targetDir.substr(libDir.length + 1).split(path.sep)[0])
    }
    const files = await globby(ignore, {
        gitignore: true,
        cwd: libDir,
        nodir: true
    })
    return files.sort()
}

function buildLibrary(name, dir) {
    // Run install if never done before
    if (!fs.existsSync(path.join(dir, "node_modules"))) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m Running 'install' in ${dir}`)
        spawn.sync(["install"], {cwd: dir, stdio: [0, 1, 2]})
    }

    // Run build script if present
    const libraryPkgJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    if (!libraryPkgJson.name === name) {
        console.error(`\x1b[33m[relative-deps]\x1b[0m[ERROR] Mismatch in package name: found '${libraryPkgJson.name}', expected '${name}'`)
        process.exit(1)
    }
    if (libraryPkgJson.scripts && libraryPkgJson.scripts.build) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m Building ${name} in ${dir}`)
        spawn.sync(["run", "build"], {cwd: dir, stdio: [0, 1, 2]})
    }
}

function hookStdio(proc, label) {
    proc.stdout.on('data', (data) => {
        if (String(data).includes("\033[2J") || String(data).includes("\033c")) {
            console.log(`\x1b[94m[${label}]\x1b[0m Tried to clear console`);
            return;
        }
        console.log(`\x1b[94m[${label}]\x1b[0m ${String(data).trim()}`);
    });
    proc.stderr.on('data', (data) => {
        if (String(data).includes("\033[2J") || String(data).includes("\033c")) {
            console.log(`\x1b[31m[${label}]\x1b[0m Tried to clear console`);
            return;
        }
        console.error(`\x1b[31m[${label}]\x1b[0m ${String(data).trim()}`);
    });
    proc.on('close', (code) => {
        console.log(`\x1b[90m[${label}]\x1b[0m process exited with code ${code}`);
    });
}

function buildAndWatchNextLibrary(name, dir) {
    // Run install if never done before
    if (!fs.existsSync(path.join(dir, "node_modules"))) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m Running 'install' in ${dir}`)
        const installProcess = spawn.sync(["install"], {cwd: dir})
        hookStdio(installProcess, `${name}:npm install`);
    }

    // Run build script if present
    const libraryPkgJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    if (!libraryPkgJson.name === name) {
        console.error(`\x1b[33m[relative-deps]\x1b[0m[ERROR] Mismatch in package name: found '${libraryPkgJson.name}', expected '${name}'`)
        process.exit(1)
    }
    if (libraryPkgJson.scripts && libraryPkgJson.scripts.build) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m Building ${name} in ${dir}`)
        buildWatchProcess = spawn(["run", "dev"], {cwd: dir})
        hookStdio(buildWatchProcess, `${name}:npm run dev`);
        cpxWatchProcess = spawn(["run", "cpx:watch"], {cwd: dir})
        hookStdio(cpxWatchProcess, `${name}:npm run cpx:watch`);
    }
}

async function packAndInstallLibrary(name, dir, targetDir) {
    const libDestDir = path.join(targetDir, "node_modules", name)
    let fullPackageName
    try {
        console.log("\x1b[33m[relative-deps]\x1b[0m Copying to local node_modules")
        spawn.sync(["pack"], {cwd: dir})

        if (fs.existsSync(libDestDir)) {
            // TODO: should we really remove it? Just overwritting could be fine
            await rimraf(libDestDir, {preserveRoot: true})
        }
        fs.mkdirSync(libDestDir, {recursive: true})

        const tmpName = name.replace(/[\s\/]/g, "-").replace(/@/g, "")
        // npm replaces @... with at- where yarn just removes it, so we test for both files here
        const regex = new RegExp(`^(at-)?${tmpName}(.*).tgz$`)

        const packagedName = fs.readdirSync(dir).find(file => regex.test(file))
        fullPackageName = path.join(dir, packagedName)

        console.log(`\x1b[33m[relative-deps]\x1b[0m Extracting "${fullPackageName}" to ${libDestDir}`)

        const [cwd, file] = [libDestDir, fullPackageName].map(absolutePath =>
            path.relative(process.cwd(), absolutePath)
        )

        tar.extract({
            cwd,
            file,
            gzip: true,
            stripComponents: 1,
            sync: true
        })
    } finally {
        if (fullPackageName) {
            fs.unlinkSync(fullPackageName)
        }
    }
}

async function getFileHash(file) {
    return await new Promise((resolve, reject) => {
        checksum.file(file, (error, hash) => {
            if (error) reject(error)
            else resolve(hash)
        })
    })
}

function addScriptToPackage(script) {
    let pkg = getPackageJson()
    if (!pkg.scripts) {
        pkg.scripts = {}
    }

    const msg = `\x1b[33m[relative-deps]\x1b[0m Adding relative-deps to ${script} script in package.json`

    if (!pkg.scripts[script]) {
        console.log(msg)
        pkg.scripts[script] = "relative-deps"

    } else if (!pkg.scripts[script].includes("relative-deps")) {
        console.log(msg)
        pkg.scripts[script] = `${pkg.scripts[script]} && relative-deps`
    }
    setPackageData(pkg)
}

function installRelativeDepsPackage() {
    let pkg = getPackageJson()

    if (!(
        (pkg.devDependencies && pkg.devDependencies["relative-deps"]) ||
        (pkg.dependencies && pkg.dependencies["relative-deps"])
    )) {
        console.log('\x1b[33m[relative-deps]\x1b[0m Installing relative-deps package')
        spawn.sync(["add", "-D", "relative-deps"])
    }
}

function setupEmptyRelativeDeps() {
    let pkg = getPackageJson()

    if (!pkg.relativeDependencies) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m Setting up relativeDependencies section in package.json`)
        pkg.relativeDependencies = {}
        setPackageData(pkg)
    }
}

function initRelativeDeps({script}) {
    installRelativeDepsPackage()
    setupEmptyRelativeDeps()
    addScriptToPackage(script)
}

async function addRelativeDeps({paths, dev, script}) {
    initRelativeDeps({script})

    if (!paths || paths.length === 0) {
        console.log(`\x1b[33m[relative-deps]\x1b[0m[WARN] no paths provided running ${script}`)
        spawn.sync([script])
        return
    }
    const libraries = paths.map(relPath => {
        const libPackagePath = path.resolve(process.cwd(), relPath, "package.json")
        if (!fs.existsSync(libPackagePath)) {
            console.error(
                `\x1b[33m[relative-deps]\x1b[0m[ERROR] Failed to resolve dependency ${relPath}`
            )
            process.exit(1)
        }

        const libraryPackageJson = JSON.parse(fs.readFileSync(libPackagePath, "utf-8"))

        return {
            relPath,
            name: libraryPackageJson.name,
            version: libraryPackageJson.version
        }
    })

    let pkg = getPackageJson()

    const depsKey = dev ? "devDependencies" : "dependencies"
    if (!pkg[depsKey]) pkg[depsKey] = {}

    libraries.forEach(library => {
        if (!pkg[depsKey][library.name]) {
            try {
                spawn.sync(["add", ...[dev ? ["-D"] : []], library.name], {stdio: "ignore"})
            } catch (_e) {
                console.log(`\x1b[33m[relative-deps]\x1b[0m[WARN] Unable to fetch ${library.name} from registry. Installing as a relative dependency only.`)
            }
        }
    })

    if (!pkg.relativeDependencies) pkg.relativeDependencies = {}

    libraries.forEach(dependency => {
        pkg.relativeDependencies[dependency.name] = dependency.relPath
    })

    setPackageData(pkg)
    await installRelativeDeps()
}

function setPackageData(pkgData) {
    const source = getPackageJson()
    fs.writeFileSync(
        path.join(process.cwd(), "package.json"),
        JSON.stringify(merge(source, pkgData), null, 2)
    )
}

function getPackageJson() {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), "utf-8"))
}

module.exports.watchRelativeDeps = watchRelativeDeps
module.exports.watchRelativeDepsWithNext = watchRelativeDepsWithNext
module.exports.watchRelativeDepsNewArch = watchRelativeDepsNewArch
module.exports.installRelativeDeps = installRelativeDeps
module.exports.initRelativeDeps = initRelativeDeps
module.exports.addRelativeDeps = addRelativeDeps

process.on('SIGINT', () => {
    console.log("Terminating child processes...")
    if (existingProcess) existingProcess.kill('SIGINT')
    if (buildWatchProcess) buildWatchProcess.kill('SIGINT')
    if (cpxWatchProcess) cpxWatchProcess.kill('SIGINT')
    obsoleteProcesses.forEach(p => p.kill('SIGINT'))
    console.log("Child processes terminated...")
    process.exit(0)
})
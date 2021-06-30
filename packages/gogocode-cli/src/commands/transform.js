'use strict'

const chalk = require('chalk');
const ProgressBar = require('progress');
const path = require('path');
const fse = require('fs-extra');
const $ = require('gogocode');
const fileUtil = require('../util/file');
const check = require('../util/check');
const cmd = require('../util/cmd');
const inquirer = require('inquirer');
let PWD_PATH, CLI_INSTALL_PATH;
const EXCLUDE_FILES = ['.gif', '.jpg', '.png', '.jpeg', '.css', '.less'];

function checkPath(srcPath, outPath, transform) {
    return new Promise((resolve, reject) => {
        if (!srcPath) {
            reject();
            return;
        }
        if (srcPath == 'rc') {
            console.error(`command error: must be ${chalk.green('--src')} or ${chalk.green('-s')}`);
            reject();
            return;
        }
        const srcAbsPath = path.resolve(PWD_PATH, srcPath);
        if (!fse.existsSync(srcAbsPath)) {
            console.error(`error:source file not exists：${srcAbsPath}`);
            reject();
            return;
        }

        if (!transform) {
            console.error(`command error: need -t or --transform`);
            reject();
            return;
        }
        //transform 支持多个，逗号分隔
        const tempArr = transform.split(',');
        for (let i = 0; i < tempArr.length; i++) {
            const tPath = tempArr[i];
            if (tPath.lastIndexOf('.') > -1) {
                const tranFilePath = path.resolve(PWD_PATH, tPath);
                if (!fse.existsSync(tranFilePath)) {
                    console.error(`error: plugin or transform file not exists：${tranFilePath}`);
                    reject();
                    return;
                }
            }
        }

        if (!outPath) {
            console.error(`command error: need -o or--out `);
            reject();
            return;
        }
        if (outPath == 'ut') {
            console.error(`command error: must be ${chalk.green('--out')} or ${chalk.green('-o')}`);
            reject();
            return;
        }

        const outAbsPath = path.resolve(PWD_PATH, outPath);

        const srcIsDir = fse.statSync(srcAbsPath).isDirectory();

        let outIsDir;
        if (fse.existsSync(outAbsPath)) {
            outIsDir = fse.statSync(outAbsPath).isDirectory()
        } else {
            outIsDir = !path.extname(outAbsPath);
        }

        if (srcIsDir && !outIsDir) {
            console.error('transform error：source is folder，output is the file');
            reject();
            return;
        }
        //check same path
        if (srcAbsPath === outAbsPath) {
            inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'samePath',
                    message: 'source path and output path is same. source file will be rewrite! to be continue?',
                    default: false,
                }
            ]).then(answers => {
                if (answers.samePath) {
                    resolve();
                } else {
                    reject();
                }
            }).catch(() => {
                reject();
            });
        } else {
            resolve();
        }

    });
}
function tryLoadPackage(packageName, resolve, reject) {
    try {
        const tranFn = require(packageName);
        resolve({ name: packageName, fn: tranFn });
    } catch (err) {
        console.error(err);
        reject(err);
    }
}
function ppt(tranFns, options) {
    const api = { gogocode: $ };
    tranFns.forEach((tran) => {
        try {
            tran.fn(null, api, options);
        } catch (err) {
            console.error(err);
        }
    });
}
/**
 * 在插件转换之前
 * @param {*} tranFns 
 * @param {*} options 
 */
function preTransform(tranFns, options) {
    options.period = 'preTransform';
    ppt(tranFns, options);
}
/**
 * 插件转换之后
 * @param {*} tranFns 
 * @param {*} options 
 */
function postTransform(tranFns, options) {
    options.period = 'postTransform';
    ppt(tranFns, options);
}
/**
 * 
 * @param {*} tranFns plugin main function
 * @param {*} options options
 * @param {*} srcFilePath srcFilePath
 * @param {*} outFilePath outFilePath
 * @returns {success or failed}
 */
function execTransforms(tranFns, options, srcFilePath, outFilePath) {
    options.period = 'transform';
    options.outFilePath = outFilePath;

    let source = null;
    try {
        source = fse.readFileSync(srcFilePath).toString();
    } catch (err) {
        console.log('transform error: ' + srcFilePath);
        console.error(err);
        return { success: false };
    }
    if (source === null) {
        return { success: false };
    }
    //空文件处理
    if (source.trim() === '') {
        fse.writeFileSync(outFilePath, source);
        return { success: true };
    }
    let success = true;
    tranFns.forEach((tran, index) => {
        const { name, fn } = tran;
        
        try {
            // 多个transform 时候会多次写入outFullPath。outFullPath即是源文件也是输出文件
            const fileInfo = { source, path: index === 0 ? srcFilePath : outFilePath };
            const api = { gogocode: $ };
          
            source = fn(fileInfo,
                api,
                options);
            if (typeof source === 'string') {
                fse.writeFileSync(outFilePath, source);
            } else {
                throw new Error(`plugin error：${name} ,must return string content`);
            }
        } catch (err) {
            console.log('transform error: ' + srcFilePath);
            console.error(err);
            success = false;
        }
    });
    return { success };
}

function requireTransforms(transform) {


    return new Promise((resolve, reject) => {
        const tranFullPath = path.resolve(PWD_PATH, transform);

        if (path.extname(tranFullPath)) {
            // 本地文件
            try {
                const dotIndex = tranFullPath.lastIndexOf('.');
                const tPath = tranFullPath.substring(0, dotIndex);
                const tranFn = require(tPath);
                resolve({ name: transform, fn: tranFn });
            } catch (err) {
                reject(err);
            }
        } else {
            // npm包
            const nodeModulesDir = check.getGlobalPath();

            check.needUpdate(transform, nodeModulesDir).then((need) => {
                const pkPath = path.join(nodeModulesDir, transform);
                if (need) {
                    try {
                        console.log(`${chalk.green(transform)} installing ......`);
                        cmd.runSync('npm', ['install', transform, '-g']);
                        console.log(`${chalk.green(transform)} install complete`);
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    tryLoadPackage(pkPath, resolve, reject);
                } else {
                    tryLoadPackage(pkPath, resolve, reject);
                }
            }).catch(err => reject(err));
        }
    });
}
function mkOutDir(outDir) {
    //如果是文件，取最后一个路径
    if (outDir.indexOf('.') > 0) {
        outDir = path.dirname(outDir);
    }
    if (!fse.existsSync(outDir)) {
        fse.mkdirsSync(outDir);
    }
}
function logSuccess(result) {
    if (result) {
        console.log();
        console.log(chalk.green(`transform success!!`));
        console.log();
    } else {
        console.log();
        console.log(chalk.yellow(`transform failed!`));
        console.log();
    }
}
function handleCommand({ srcPath, outPath, transform, resolve, reject }) {
    const srcFullPath = path.resolve(PWD_PATH, srcPath);
    const outFullPath = path.resolve(PWD_PATH, outPath);
    const srcIsDir = fse.statSync(srcFullPath).isDirectory();

    console.log();
    console.log(chalk.green(`transform start`));
    console.log();

    const tempArr = transform.split(',');
    Promise.all(tempArr.map((tPath) =>
        requireTransforms(tPath)
    )).then((tranFns) => {
        try {
            const options = {
                pwdPath: PWD_PATH,
                rootPath: srcFullPath,
                outRootPath: outFullPath
            };
            preTransform(tranFns, options);

            if (srcIsDir) {
                const files = fileUtil.listFiles(srcFullPath);
                let result = true;
                var bar = new ProgressBar('transform in progress: [:bar] :current/:total    ', { total: files.length });
                files.forEach((srcFilePath) => {
                    let filePath = srcFilePath.substring(srcFullPath.length, srcFilePath.length);
                    let outFilePath = path.join(outFullPath, filePath);
                    mkOutDir(outFilePath);

                    const ext = path.extname(srcFilePath);
                    if (EXCLUDE_FILES.indexOf(ext) !== -1) {
                        fse.copyFileSync(srcFilePath, outFilePath);
                    } else {
                        const { success } = execTransforms(tranFns, options, srcFilePath, outFilePath);
                        if (!success) { result = success; }
                    }
                    bar.tick();
                });
                logSuccess(result);
            } else {
                mkOutDir(outFullPath);
                execTransforms(tranFns, options, srcFullPath, outFullPath);
                const { success } = execTransforms(tranFns, options, srcFullPath, outFullPath);
                logSuccess(success);
            }

            postTransform(tranFns, options);
            resolve();

        } catch (error) {
            console.error(error);
            reject(error);
        }
    }).catch((error) => {
        console.error(error);
        reject(error);
    })
}
module.exports = ({ src: srcPath, out: outPath, transform, dry }) => {
    PWD_PATH = process.cwd();
    CLI_INSTALL_PATH = path.resolve(__dirname, '../../');
    // 临时目录，dry==true 的时候使用
    const tempPath = path.resolve(CLI_INSTALL_PATH, './temp_out');
    if (fse.existsSync(tempPath)) {
        fse.removeSync(tempPath);
    }
    if (dry) {
        outPath = tempPath;
    }
    return new Promise((resolve, reject) => {
        checkPath(srcPath, outPath, transform).then(() => {
            handleCommand({ srcPath, outPath, transform, resolve, reject });
        }).catch(() => {
            reject();
        });
    });
}
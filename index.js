const pkg = require('./package.json');
const pgp = require('pg-promise')();
const program = require('commander');
const chalk = require('chalk');
const request = require('request');
const rp = require('request-promise');
const R = require('ramda');
const streamBuffers = require('stream-buffers');
const blake = require('blakejs');
const uuid = require("uuid")

const defaultConfig = pkg.defaultConfig;
const database = pkg.database;
const availableAct = ['createdb', 'createtbl', 'filldb', 'loaddb'];
let action;

program
    .version(pkg.version)
    .arguments('<act>')
    .option('-u --user [user]', 'set user', defaultConfig.user)
    .option('-p --password [password]', 'set password', defaultConfig.password)
    .option('-h --host [host]', 'set host', defaultConfig.host)
    .option('-p --port [port]', 'set port', defaultConfig.port)
    .action((act) => action = act);
program.parse(process.argv);
if (!(availableAct.includes(action))) {
    program.outputHelp();
    process.exit();
}

switch (action) {
    case 'createdb':
        createDataBase();
        break;
    case 'createtbl':
        createTables();
        break;
    case 'filldb':
        fillDatabase();
        break;
    case 'loaddb':
        loadFromDatabase();
        break;
    default:
        break;
}

function createDataBase() {
}

function createTables() {
}

function loadFromDatabase() {
}

async function fillDatabase() {
    let imgTag = '暴走漫画';
    let legalImgs = R.pipe(R.filter(filterImg), R.uniqBy((img) => img.id))(await getImgUrlList(imgTag));
    success(`${legalImgs.length} images available`);

    const db = pgp({
        user: program.user,
        database: database,
        password: program.password,
        host: program.host,
        port: program.port,
    });

    async function getAllTags() {
        let tags = new Map();
        let rows = await db.any('SELECT * FROM tag');
        rows.forEach((r) => tags.set(r.content, r.exp));

        return tags;
    }

    // upload GIF to OSS
    function uploadGIF(imgData) {
        return new Promise((resolve, reject) => {
            resolve('url', 'source');
        });
    }

    function newGIFItem(img, url, src) {
        return db.none('INSERT INTO gif VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, LOCALTIMESTAMP, LOCALTIMESTAMP)', [
            img.id,
            url,
            img.tags,
            img.characteristics,
            [],
            img.size,
            'gif',
            img.hash,
            src
        ]);
    }

    let imgCount = 0;
    let tags = null;
    let newTags = new Map();
    let nextTagExp;

    try {
        tags = await getAllTags();
        nextTagExp = tags.size;
    }
    catch (err) {
        error('Get tags failed\n');
        return;
    }

    for (let img of legalImgs) {
        try {
            let imgData = await (fetchImgData(img));
            img.hash = Buffer.from(blake.blake2b(imgData));
            img.id = Buffer.alloc(32);
            uuid.v4(null, img.id, 0);
            // img.tags
            img.characteristics = img.tags.map((t) => {
                if (tags.has(t)) {
                    return tags.get(t);
                }
                else if (newTags.has(t)) {
                    return newTags.get(t);
                }
                else {
                    newTags.set(t, nextTagExp);
                    return nextTagExp++;
                }
            });

            let url, src = await uploadGIF(imgData);
            newGIFItem(img, url, src)
                .then(() => imgCount++)
                .catch(() => error('Insert new GIF failed, remove file from OSS'));
        } catch (err) {
            //error when fetching image data
            error(err.message);
        }
    }

    success(`${imgCount} images filled into database`);

    // insert new tags
    let col = new pgp.helpers.ColumnSet(['content', 'exp'], { table: 'tag' });
    let newTagArray = [];
    newTags.forEach((v, k) => newTagArray.push({ content: k, exp: v }));
    let qr = pgp.helpers.insert(newTagArray, col);
    db.none(qr)
        .then(() => success(`Update ${newTagArray.length} new tags`))
        // should backup new tags when failed
        .catch(() => error('Update tags failed'));
}

function fetchImgData(img) {
    return new Promise(async(resolve, reject) => {
        let stream = new streamBuffers.WritableStreamBuffer({
            initialSize: (100 * 1024),
            incrementAmount: (10 * 1024)
        });

        try {
            await new Promise((resolve, reject) => {
                request(`${pkg.imgRepo}${img.url}`)
                    .on('error', (err) => reject(err))
                    .on('end', () => resolve())
                    .pipe(stream);
            });
            stream.end();
            if (stream.size() < 100 * 1024) {
                resolve(stream.getContents());
            } else {
                reject(new Error('Image size exceeds size limit'));
            }
        } catch (err) {
            reject(err);
        }
    });
}

async function getImgUrlList(tag) {
    let i = 1,
        imgUrlList = [];

    while (true) {
        try {
            let resJson = await rp({
                uri: pkg.imgAPI,
                qs: {
                    page: i++,
                    step: pkg.imgChunkSize,
                    keyword: tag,
                    via: 4
                },
                transform: JSON.parse
            });
            if (resJson.hasOwnProperty('isOverTotalNum')) {
                success(`fetch ${resJson.modelList.length} image urls`);
                imgUrlList = imgUrlList.concat(resJson.modelList);
                if (resJson.isOverTotalNum === "true") {
                    break;
                }
            } else {
                throw new Error('response json has no [isOverTotalNum] property');
            }
        } catch (err) {
            error(err.message);
            break;
        }
    }

    return imgUrlList;
}

function filterImg(img) {
    return img.width < 240 &&
        img.height < 240 &&
        img.size < 100 * 1024;
}

function success(message) {
    console.log(chalk.green(message));
}

function error(message) {
    console.log(chalk.red(message));
}
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
const nn = require('./nearest');
const OSS = require('ali-oss').Wrapper;

const defaultConfig = pkg.defaultConfig;
const database = defaultConfig.database;
const availableAct = ['createdb', 'fm', 'filldb', 'loaddb'];
const ossConfig = pkg.oss;
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
chalk.enabled = true;

switch (action) {
    case 'createdb':
        createDataBase();
        break;
    case 'fm':
        calcMatch();
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

function loadFromDatabase() {
}

async function calcMatch() {
    const db = pgp({
        user: program.user,
        database: database,
        password: program.password,
        host: program.host,
        port: program.port,
    });

    let rows = await db.any('SELECT id, characteristics FROM gif');
    let featarr = rows.map((r) => r.characteristics);
    let uprows = rows.map((r) => ({ id: r.id, match: [r.id] }));
    uprows.forEach((v, i, ur) => {
        let neighbours = nn.nearestNeighbourN(featarr[i], [...featarr.slice(0, i), ...featarr.slice(i + 1)], 10);
        neighbours.forEach((n) => {
            if (n >= i) {
                v.match.push(ur[n + 1].id);
            }
            else {
                v.match.push(ur[n].id);
            }
        });
    });

    var cs = new pgp.helpers.ColumnSet([
        new pgp.helpers.Column({ name: 'id', cast: '::uuid', cnd: true }),
        new pgp.helpers.Column({ name: 'match', cast: '::uuid[]' })],
        { table: 'gif' });
    let qr = pgp.helpers.update(uprows, cs) + ' WHERE v.id = t.id';
    db.none(qr)
        .then(() => success('Update match successfuly'))
        // should backup new tags when failed
        .catch((err) => error(`Update match failed: ${err}`));
}

async function fillDatabase() {
    let imgTag = ['暴走漫画', '妈的智障', '宝宝心里哭', '生无可恋'];
    let legalImgs = [];
    await Promise.all(imgTag.map((tag) => {
        return new Promise(async (resolve) => resolve(R.pipe(R.filter(filterImg), R.uniqBy((img) => img.id))(await getImgUrlList(tag))));
    }))
        .then((urlListArray) => urlListArray.forEach((urlList) => legalImgs = legalImgs.concat(urlList)));
    success(`${legalImgs.length} images available`);

    const db = pgp({
        user: program.user,
        database: database,
        password: program.password,
        host: program.host,
        port: program.port,
    });

    const client = new OSS({
        region: 'oss-cn-shenzhen',
        accessKeyId: ossConfig.accessKeyId,
        accessKeySecret: ossConfig.accessKeySecret,
        bucket: 'agb-image'
    });

    // upload GIF to OSS
    function uploadGIF(fileName, imgData) {
        return new Promise((resolve, reject) => {
            client.put(fileName, imgData)
                .then(() => resolve(`http://agb-image.oss-cn-shenzhen.aliyuncs.com/${fileName}.gif`, 'agb-keeper'))
                .catch(() => reject({ message: `upload ${fileName} to OSS failed` }));
        });
    }

    async function getAllTags() {
        let tags = new Map();
        let rows = await db.any('SELECT * FROM tag');
        rows.forEach((r) => tags.set(r.content, r.exp));

        return tags;
    }

    function newGIFItem(img, url, src) {
        return db.none('INSERT INTO gif VALUES ($1, $2, $3::varchar(32)[], $4::integer[], $5::uuid[], $6, $7, $8, $9, LOCALTIMESTAMP, LOCALTIMESTAMP)', [
            img.id,
            url,
            img.tags,
            img.characteristics,
            [img.id],
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
    let prArray = [];

    try {
        tags = await getAllTags(db);
        nextTagExp = tags.size;
    }
    catch (err) {
        error('Get tags failed');
        return;
    }

    for (let img of legalImgs) {
        try {
            let imgData = await (fetchImgData(img));
            img.hash = Buffer.from(blake.blake2b(imgData));
            img.id = uuid.v4();
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

            let url, src = await uploadGIF(img.id, imgData);
            prArray.push(new Promise((resolve) => newGIFItem(img, url, src)
                .then(() => { imgCount++; resolve(); })
                .catch((err) => { 
                    error(`insert new GIF failed, remove file from OSS: ${err}`); 
                    client.delete(img.id).catch(() => error(`delete ${img.id} from OSS failed`));
                    resolve(); })));
        } catch (err) {
            //error when fetching image data
            error(err.message);
        }
    }

    await Promise.all(prArray);
    success(`${imgCount} images filled into database`);

    // insert new tags
    let col = new pgp.helpers.ColumnSet(['content', 'exp'], { table: 'tag' });
    let newTagArray = [];
    newTags.forEach((v, k) => newTagArray.push({ content: k, exp: v }));
    let qr = pgp.helpers.insert(newTagArray, col);
    db.none(qr)
        .then(() => success(`Update ${newTagArray.length} new tags`))
        // should backup new tags when failed
        .catch((err) => error(`Update tags failed: ${err}`));
}

function fetchImgData(img) {
    return new Promise(async (resolve, reject) => {
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
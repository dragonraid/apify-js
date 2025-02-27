// eslint-disable-next-line max-classes-per-file
import sinon from 'sinon';
import _ from 'underscore';
import fs from 'fs';
import path from 'path';
import os from 'os';
import cheerio from 'cheerio';
import semver from 'semver';
import { ENV_VARS } from '@apify/consts';
import Apify from '../build/index';
import * as utils from '../build/utils';
import log from '../build/utils_log';
import * as requestUtils from '../build/utils_request';
import * as htmlToTextData from './data/html_to_text_test_data';

describe('utils.newClient()', () => {
    test('reads environment variables correctly', () => {
        process.env[ENV_VARS.API_BASE_URL] = 'http://www.example.com:1234/path';
        process.env[ENV_VARS.TOKEN] = 'token';
        const client = utils.newClient();

        expect(client.constructor.name).toBe('ApifyClient');
        expect(client.token).toBe('token');
        expect(client.baseUrl).toBe('http://www.example.com:1234/path/v2');
    });

    test('uses correct default if APIFY_API_BASE_URL is not defined', () => {
        delete process.env[ENV_VARS.API_BASE_URL];
        process.env[ENV_VARS.TOKEN] = 'token';
        const client = utils.newClient();

        expect(client.token).toBe('token');
        expect(client.baseUrl).toBe('https://api.apify.com/v2');
    });
});

describe('utils.addCharsetToContentType()', () => {
    test('works', () => {
        expect(utils.addCharsetToContentType('application/json; charset=something')).toBe('application/json; charset=something');
        expect(utils.addCharsetToContentType('application/json; foo=bar; charset=something')).toBe('application/json; foo=bar; charset=something');
        expect(utils.addCharsetToContentType('application/json; foo=bar')).toBe('application/json; charset=utf-8; foo=bar');
        expect(utils.addCharsetToContentType('application/json')).toBe('application/json; charset=utf-8');
        expect(utils.addCharsetToContentType(null)).toBe(null);
        expect(utils.addCharsetToContentType(undefined)).toEqual(undefined);
    });
});

describe('utils.isDocker()', () => {
    test('works for dockerenv && cgroup', () => {
        sinon.stub(fs, 'stat').callsFake((filePath, callback) => callback(null));
        sinon.stub(fs, 'readFile').callsFake((filePath, encoding, callback) => callback(null, 'something ... docker ... something'));

        return utils
            .isDocker(true)
            .then((is) => {
                expect(is).toBe(true);
                fs.stat.restore();
                fs.readFile.restore();
            });
    });

    test('works for dockerenv', () => {
        sinon.stub(fs, 'stat').callsFake((filePath, callback) => callback(null));
        sinon.stub(fs, 'readFile').callsFake((filePath, encoding, callback) => callback(null, 'something ... ... something'));

        return utils
            .isDocker(true)
            .then((is) => {
                expect(is).toBe(true);
                fs.stat.restore();
                fs.readFile.restore();
            });
    });

    test('works for cgroup', () => {
        sinon.stub(fs, 'stat').callsFake((filePath, callback) => callback(new Error()));
        sinon.stub(fs, 'readFile').callsFake((filePath, encoding, callback) => callback(null, 'something ... docker ... something'));

        return utils
            .isDocker(true)
            .then((is) => {
                expect(is).toBe(true);
                fs.stat.restore();
                fs.readFile.restore();
            });
    });

    test('works for nothing', () => {
        sinon.stub(fs, 'stat').callsFake((filePath, callback) => callback(new Error()));
        sinon.stub(fs, 'readFile').callsFake((filePath, encoding, callback) => callback(null, 'something ... ... something'));

        return utils
            .isDocker(true)
            .then((is) => {
                expect(is).toBe(false);
                fs.stat.restore();
                fs.readFile.restore();
            });
    });
});

describe('utils.getMemoryInfo()', () => {
    test('works WITHOUT child process outside the container', async () => {
        const osMock = sinon.mock(os);
        const utilsMock = sinon.mock(utils);

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(false));

        osMock
            .expects('freemem')
            .atLeast(1)
            .returns(222);

        osMock
            .expects('totalmem')
            .atLeast(1)
            .returns(333);

        try {
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
            expect(data.mainProcessBytes).toBeGreaterThanOrEqual(20000000);
        } finally {
            utilsMock.verify();
            osMock.verify();
        }
    });

    test('works WITHOUT child process inside the container', async () => {
        const utilsMock = sinon.mock(utils);

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(true));

        sinon
            .stub(fs, 'access')
            .callsFake((file, mode, callback) => callback(null));

        sinon
            .stub(fs, 'readFile')
            .callsFake((filePath, encoding, callback) => {
                if (filePath === '/sys/fs/cgroup/memory/memory.limit_in_bytes') callback(null, '333');
                else if (filePath === '/sys/fs/cgroup/memory/memory.usage_in_bytes') callback(null, '111');
                else throw new Error('Invalid path');
            });

        try {
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
            expect(data.mainProcessBytes).toBeGreaterThanOrEqual(20000000);
        } finally {
            utilsMock.verify();
            fs.readFile.restore();
            fs.access.restore();
        }
    });

    test('works WITH child process outside the container', async () => {
        const osMock = sinon.mock(os);
        const utilsMock = sinon.mock(utils);
        process.env[ENV_VARS.HEADLESS] = '1';

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(false));

        osMock
            .expects('freemem')
            .atLeast(1)
            .returns(222);

        osMock
            .expects('totalmem')
            .atLeast(1)
            .returns(333);

        let browser;
        try {
            browser = await Apify.launchPuppeteer();
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
            expect(data.mainProcessBytes).toBeGreaterThanOrEqual(20000000);
            expect(data.childProcessesBytes).toBeGreaterThanOrEqual(20000000);
        } finally {
            utilsMock.verify();
            osMock.verify();
            delete process.env[ENV_VARS.HEADLESS];
            if (browser) await browser.close();
        }
    });

    test('works WITH child process inside the container', async () => {
        const utilsMock = sinon.mock(utils);
        process.env[ENV_VARS.HEADLESS] = '1';

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(true));

        sinon
            .stub(fs, 'access')
            .callsFake((file, mode, callback) => callback(null));

        sinon
            .stub(fs, 'readFile')
            .callsFake((filePath, encoding, callback) => {
                if (filePath === '/sys/fs/cgroup/memory/memory.limit_in_bytes') callback(null, '333');
                else if (filePath === '/sys/fs/cgroup/memory/memory.usage_in_bytes') callback(null, '111');
                else throw new Error('Invalid path');
            });

        let browser;
        try {
            browser = await Apify.launchPuppeteer();
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
            expect(data.mainProcessBytes).toBeGreaterThanOrEqual(20000000);
            expect(data.childProcessesBytes).toBeGreaterThanOrEqual(20000000);
        } finally {
            utilsMock.verify();
            fs.readFile.restore();
            fs.access.restore();
            delete process.env[ENV_VARS.HEADLESS];
            if (browser) browser.close();
        }
    });

    test('works with cgroup V1 with LIMITED memory', async () => {
        const utilsMock = sinon.mock(utils);

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(true));

        sinon
            .stub(fs, 'access')
            .callsFake((file, mode, callback) => callback(null));

        sinon
            .stub(fs, 'readFile')
            .callsFake((filePath, encoding, callback) => {
                if (filePath === '/sys/fs/cgroup/memory/memory.limit_in_bytes') callback(null, '333');
                else if (filePath === '/sys/fs/cgroup/memory/memory.usage_in_bytes') callback(null, '111');
                else throw new Error('Invalid path');
            });

        try {
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
        } finally {
            utilsMock.verify();
            fs.readFile.restore();
            fs.access.restore();
        }
    });

    test('works with cgroup V1 with UNLIMITED memory', async () => {
        const utilsMock = sinon.mock(utils);
        const osMock = sinon.mock(os);

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(true));

        sinon
            .stub(fs, 'access')
            .callsFake((file, mode, callback) => callback(null));

        sinon
            .stub(fs, 'readFile')
            .callsFake((filePath, encoding, callback) => {
                if (filePath === '/sys/fs/cgroup/memory/memory.limit_in_bytes') callback(null, '9223372036854771712');
                else if (filePath === '/sys/fs/cgroup/memory/memory.usage_in_bytes') callback(null, '111');
                else throw new Error('Invalid path');
            });

        osMock
            .expects('totalmem')
            .once()
            .returns(333);

        try {
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
        } finally {
            utilsMock.verify();
            osMock.verify();
            fs.readFile.restore();
            fs.access.restore();
        }
    });

    test('works with cgroup V2 with LIMITED memory', async () => {
        const utilsMock = sinon.mock(utils);

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(true));

        sinon
            .stub(fs, 'access')
            .callsFake((file, mode, callback) => callback('error'));

        sinon
            .stub(fs, 'readFile')
            .callsFake((filePath, encoding, callback) => {
                if (filePath === '/sys/fs/cgroup/memory.max') callback(null, '333\n');
                else if (filePath === '/sys/fs/cgroup/memory.current') callback(null, '111\n');
                else throw new Error('Invalid path');
            });

        try {
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
        } finally {
            utilsMock.verify();
            fs.readFile.restore();
            fs.access.restore();
        }
    });

    test('works with cgroup V2 with UNLIMITED memory', async () => {
        const utilsMock = sinon.mock(utils);
        const osMock = sinon.mock(os);

        utilsMock
            .expects('isDocker')
            .once()
            .returns(Promise.resolve(true));

        sinon
            .stub(fs, 'access')
            .callsFake((file, mode, callback) => callback('error'));

        sinon
            .stub(fs, 'readFile')
            .callsFake((filePath, encoding, callback) => {
                if (filePath === '/sys/fs/cgroup/memory.max') callback(null, 'max\n');
                else if (filePath === '/sys/fs/cgroup/memory.current') callback(null, '111\n');
                else throw new Error('Invalid path');
            });

        osMock
            .expects('totalmem')
            .once()
            .returns(333);

        try {
            const data = await Apify.getMemoryInfo();
            expect(data).toMatchObject({
                totalBytes: 333,
                freeBytes: 222,
                usedBytes: 111,
            });
        } finally {
            utilsMock.verify();
            osMock.verify();
            fs.readFile.restore();
            fs.access.restore();
        }
    });
});

describe('utils.isAtHome()', () => {
    test('works', () => {
        expect(utils.isAtHome()).toBe(false);
        process.env[ENV_VARS.IS_AT_HOME] = 1;
        expect(utils.isAtHome()).toBe(true);
        delete process.env[ENV_VARS.IS_AT_HOME];
        expect(utils.isAtHome()).toBe(false);
    });
});

describe('utils.weightedAvg()', () => {
    test('works', () => {
        expect(utils.weightedAvg([10, 10, 10], [1, 1, 1])).toBe(10);
        expect(utils.weightedAvg([5, 10, 15], [1, 1, 1])).toBe(10);
        expect(utils.weightedAvg([10, 10, 10], [0.5, 1, 1.5])).toBe(10);
        expect(utils.weightedAvg([29, 35, 89], [13, 91, 3])).toEqual(((29 * 13) + (35 * 91) + (89 * 3)) / (13 + 91 + 3));
        expect(utils.weightedAvg([], [])).toEqual(NaN);
        expect(utils.weightedAvg([1], [0])).toEqual(NaN);
        expect(utils.weightedAvg([], [1])).toEqual(NaN);
    });
});

describe('Apify.utils.sleep()', () => {
    test('works', () => {
        let timeBefore;
        return Promise.resolve()
            .then(() => {
                return Apify.utils.sleep(0);
            })
            .then(() => {
                return Apify.utils.sleep();
            })
            .then(() => {
                return Apify.utils.sleep(null);
            })
            .then(() => {
                return Apify.utils.sleep(-1);
            })
            .then(() => {
                timeBefore = Date.now();
                return Apify.utils.sleep(100);
            })
            .then(() => {
                const timeAfter = Date.now();
                expect(timeAfter - timeBefore).toBeGreaterThanOrEqual(95);
            });
    });
});

describe('Apify.utils.extractUrls()', () => {
    const SIMPLE_URL_LIST = 'simple_url_list.txt';
    const UNICODE_URL_LIST = 'unicode_url_list.txt';
    const COMMA_URL_LIST = 'unicode+comma_url_list.txt';
    const TRICKY_URL_LIST = 'tricky_url_list.txt';
    const INVALID_URL_LIST = 'invalid_url_list.txt';

    const { extractUrls, URL_WITH_COMMAS_REGEX } = utils.publicUtils;

    const getURLData = (filename) => {
        const string = fs.readFileSync(path.join(__dirname, 'data', filename), 'utf8');
        const array = string.trim().split(/[\r\n]+/g).map((u) => u.trim());
        return { string, array };
    };

    const makeJSON = ({ string, array }) => JSON.stringify({
        one: [{ http: string }],
        two: array.map((url) => ({ num: 123, url })),
    });
    const makeCSV = (array, delimiter) => array.map((url) => ['ABC', 233, url, '.'].join(delimiter || ',')).join('\n');

    const makeText = (array) => {
        const text = fs.readFileSync(path.join(__dirname, 'data', 'lipsum.txt'), 'utf8').split('');
        const ID = 'ů';
        const maxIndex = text.length - 1;
        array.forEach((__, index) => {
            const indexInText = (index * 17) % maxIndex;
            if (text[indexInText] === ID) {
                text[indexInText + 1] = ID;
            } else {
                text[indexInText] = ID;
            }
        });
        return array.reduce((string, url) => string.replace(ID, ` ${url} `), text.join(''));
    };

    test('extracts simple URLs', () => {
        const { string, array } = getURLData(SIMPLE_URL_LIST);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('extracts unicode URLs', () => {
        const { string, array } = getURLData(UNICODE_URL_LIST);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('extracts unicode URLs with commas', () => {
        const { string, array } = getURLData(COMMA_URL_LIST);
        const extracted = extractUrls({ string, urlRegExp: URL_WITH_COMMAS_REGEX });
        expect(extracted).toEqual(array);
    });
    test('extracts tricky URLs', () => {
        const { string, array } = getURLData(TRICKY_URL_LIST);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('does not extract invalid URLs', () => {
        const { string } = getURLData(INVALID_URL_LIST);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(['http://www.foo.bar']);
    });
    test('extracts simple URLs from JSON', () => {
        const d = getURLData(SIMPLE_URL_LIST);
        const string = makeJSON(d);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(d.array.concat(d.array));
    });
    test('extracts unicode URLs from JSON', () => {
        const d = getURLData(UNICODE_URL_LIST);
        const string = makeJSON(d);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(d.array.concat(d.array));
    });
    test('extracts unicode URLs with commas from JSON', () => {
        const d = getURLData(COMMA_URL_LIST);
        const string = makeJSON(d);
        const extracted = extractUrls({ string, urlRegExp: URL_WITH_COMMAS_REGEX });
        expect(extracted).toEqual(d.array.concat(d.array));
    });
    test('extracts tricky URLs from JSON', () => {
        const d = getURLData(TRICKY_URL_LIST);
        const string = makeJSON(d);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(d.array.concat(d.array));
    });
    test('does not extract invalid URLs from JSON', () => {
        const d = getURLData(INVALID_URL_LIST);
        const string = makeJSON(d);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(['http://www.foo.bar', 'http://www.foo.bar']);
    });
    test('extracts simple URLs from CSV', () => {
        const { array } = getURLData(SIMPLE_URL_LIST);
        const string = makeCSV(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('extracts unicode URLs from CSV', () => {
        const { array } = getURLData(UNICODE_URL_LIST);
        const string = makeCSV(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('extracts unicode URLs with commas from semicolon CSV', () => {
        const { array } = getURLData(COMMA_URL_LIST);
        const string = makeCSV(array, ';');
        const extracted = extractUrls({ string, urlRegExp: URL_WITH_COMMAS_REGEX });
        expect(extracted).toEqual(array);
    });
    test('extracts tricky URLs from CSV', () => {
        const { array } = getURLData(TRICKY_URL_LIST);
        const string = makeCSV(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('does not extract invalid URLs from CSV', () => {
        const { array } = getURLData(INVALID_URL_LIST);
        const string = makeCSV(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(['http://www.foo.bar']);
    });
    test('extracts simple URLs from Text', () => {
        const { array } = getURLData(SIMPLE_URL_LIST);
        const string = makeText(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('extracts unicode URLs from Text', () => {
        const { array } = getURLData(UNICODE_URL_LIST);
        const string = makeText(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('extracts unicode URLs with commas from Text', () => {
        const { array } = getURLData(COMMA_URL_LIST);
        const string = makeText(array);
        const extracted = extractUrls({ string, urlRegExp: URL_WITH_COMMAS_REGEX });
        expect(extracted).toEqual(array);
    });
    test('extracts tricky URLs from Text', () => {
        const { array } = getURLData(TRICKY_URL_LIST);
        const string = makeText(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(array);
    });
    test('does not extract invalid URLs from Text', () => {
        const { array } = getURLData(INVALID_URL_LIST);
        const string = makeText(array);
        const extracted = extractUrls({ string });
        expect(extracted).toEqual(['http://www.foo.bar']);
    });
});

describe('Apify.utils.downloadListOfUrls()', () => {
    const { downloadListOfUrls } = utils.publicUtils;
    let stub;
    beforeEach(() => {
        stub = sinon.stub(requestUtils, 'requestAsBrowser');
    });
    afterEach(() => {
        requestUtils.requestAsBrowser.restore();
    });

    test('downloads a list of URLs', () => {
        const text = fs.readFileSync(path.join(__dirname, 'data', 'simple_url_list.txt'), 'utf8');
        const arr = text.trim().split(/[\r\n]+/g).map((u) => u.trim());
        stub.resolves({ body: text });

        return expect(downloadListOfUrls({
            url: 'http://www.nowhere12345.com',
        })).resolves.toEqual(arr);
    });
});

const checkHtmlToText = (html, expectedText, hasBody = false) => {
    const text1 = Apify.utils.htmlToText(html);
    expect(text1).toEqual(expectedText);

    // Test embedding into <body> gives the same result
    if (typeof html === 'string' && !hasBody) {
        const html2 = `
        <html>
            <head>
                <title>Title should be ignored</title>
                <style>
                    .styles_should_be_ignored_too {}
                </style>
                <script type="application/javascript">
                    scriptsShouldBeIgnoredToo();
                </script>
            </head>
            <body>
                ${html}
            </body>
        </html>`;
        const text2 = Apify.utils.htmlToText(html2);
        expect(text2).toEqual(expectedText);
    }
};

describe('utils.htmlToText()', () => {
    test('handles invalid args', () => {
        checkHtmlToText(null, '');
        checkHtmlToText('', '');
        checkHtmlToText(0, '');
        checkHtmlToText(undefined, '');
    });

    test('handles basic HTML elements correctly', () => {
        checkHtmlToText('Plain text node', 'Plain text node');
        checkHtmlToText('   Plain    text     node    ', 'Plain text node');
        checkHtmlToText('   \nPlain    text     node  \n  ', 'Plain text node');

        checkHtmlToText('<h1>Header 1</h1> <h2>Header 2</h2>', 'Header 1\nHeader 2');
        checkHtmlToText('<h1>Header 1</h1> <h2>Header 2</h2><br>', 'Header 1\nHeader 2');
        checkHtmlToText('<h1>Header 1</h1> <h2>Header 2</h2><br><br>', 'Header 1\nHeader 2');
        checkHtmlToText('<h1>Header 1</h1> <h2>Header 2</h2><br><br><br>', 'Header 1\nHeader 2');

        checkHtmlToText('<h1>Header 1</h1><br><h2>Header 2</h2><br><br><br>', 'Header 1\n\nHeader 2');
        checkHtmlToText('<h1>Header 1</h1> <br> <h2>Header 2</h2><br><br><br>', 'Header 1\n\nHeader 2');
        checkHtmlToText('<h1>Header 1</h1>  \n <br>\n<h2>Header 2</h2><br><br><br>', 'Header 1\n\nHeader 2');
        checkHtmlToText('<h1>Header 1</h1>  \n <br>\n<br><h2>Header 2</h2><br><br><br>', 'Header 1\n\n\nHeader 2');
        checkHtmlToText('<h1>Header 1</h1>  \n <br>\n<br><br><h2>Header 2</h2><br><br><br>', 'Header 1\n\n\n\nHeader 2');

        checkHtmlToText('<div><div>Div</div><p>Paragraph</p></div>', 'Div\nParagraph');
        checkHtmlToText('<div>Div1</div><!-- Some comments --><div>Div2</div>', 'Div1\nDiv2');

        checkHtmlToText('<div>Div1</div><style>Skip styles</style>', 'Div1');
        checkHtmlToText('<script>Skip_scripts();</script><div>Div1</div>', 'Div1');
        checkHtmlToText('<SCRIPT>Skip_scripts();</SCRIPT><div>Div1</div>', 'Div1');
        checkHtmlToText('<svg>Skip svg</svg><div>Div1</div>', 'Div1');
        checkHtmlToText('<canvas>Skip canvas</canvas><div>Div1</div>', 'Div1');

        checkHtmlToText('<b>A  B  C  D  E\n\nF  G</b>', 'A B C D E F G');
        checkHtmlToText('<pre>A  B  C  D  E\n\nF  G</pre>', 'A  B  C  D  E\n\nF  G');

        checkHtmlToText(
            '<h1>Heading 1</h1><div><div><div><div>Deep  Div</div></div></div></div><h2>Heading       2</h2>',
            'Heading 1\nDeep Div\nHeading 2',
        );

        checkHtmlToText('<a>this_word</a>_should_<b></b>be_<span>one</span>', 'this_word_should_be_one');
        checkHtmlToText('<span attributes="should" be="ignored">some <span>text</span></span>', 'some text');

        checkHtmlToText(
            `<table>
                <tr>
                    <td>Cell    A1</td><td>Cell A2</td>
                    <td>    Cell A3    </td>
                </tr>
                <tr>
                    <td>Cell    B1</td><td>Cell B2</td>
                </tr>
            </table>`,
            'Cell A1\tCell A2\tCell A3 \t\nCell B1\tCell B2',
        );
    });

    test('handles HTML entities correctly', () => {
        checkHtmlToText('<span>&aacute; &eacute;</span>', 'á é');
    });

    test('handles larger HTML documents', () => {
        const { html, text } = htmlToTextData;
        // Careful here - don't change any whitespace in the text below or the test will break, even trailing!
        checkHtmlToText(html, text, true);
    });

    test('works with Cheerio object', () => {
        const html1 = '<html><body>Some text</body></html>';
        checkHtmlToText(cheerio.load(html1, { decodeEntities: true }), 'Some text');

        const html2 = '<h1>Text outside of body</h1>';
        checkHtmlToText(cheerio.load(html2, { decodeEntities: true }), 'Text outside of body');
    });
});

describe('utils.createRequestDebugInfo()', () => {
    test('handles Puppeteer response', () => {
        const request = {
            id: 'some-id',
            url: 'https://example.com',
            loadedUrl: 'https://example.com',
            method: 'POST',
            retryCount: 2,
            errorMessages: ['xxx'],
            someThingElse: 'xxx',
            someOther: 'yyy',
        };

        const response = {
            status: () => 201,
            another: 'yyy',
        };

        const additionalFields = {
            foo: 'bar',
        };

        expect(Apify.utils.createRequestDebugInfo(request, response, additionalFields)).toEqual({
            requestId: 'some-id',
            url: 'https://example.com',
            loadedUrl: 'https://example.com',
            method: 'POST',
            retryCount: 2,
            errorMessages: ['xxx'],
            statusCode: 201,
            foo: 'bar',
        });
    });

    test('handles NodeJS response', () => {
        const request = {
            id: 'some-id',
            url: 'https://example.com',
            loadedUrl: 'https://example.com',
            method: 'POST',
            retryCount: 2,
            errorMessages: ['xxx'],
            someThingElse: 'xxx',
            someOther: 'yyy',
        };

        const response = {
            statusCode: 201,
            another: 'yyy',
        };

        const additionalFields = {
            foo: 'bar',
        };

        expect(Apify.utils.createRequestDebugInfo(request, response, additionalFields)).toEqual({
            requestId: 'some-id',
            url: 'https://example.com',
            loadedUrl: 'https://example.com',
            method: 'POST',
            retryCount: 2,
            errorMessages: ['xxx'],
            statusCode: 201,
            foo: 'bar',
        });
    });
});

describe('utils.snakeCaseToCamelCase()', () => {
    test('should camel case all sneaky cases of snake case', () => {
        const tests = {
            aaa_bbb_: 'aaaBbb',
            '': '',
            AaA_bBb_cCc: 'aaaBbbCcc',
            a_1_b_1a: 'a1B1a',
        };

        _.mapObject(tests, (camelCase, snakeCase) => {
            expect(utils.snakeCaseToCamelCase(snakeCase)).toEqual(camelCase);
        });
    });
});

describe('utils.addTimeoutToPromise()', () => {
    test('should timeout', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const p = utils.addTimeoutToPromise(
                new Promise((r) => setTimeout(r, 500)),
                100,
                'Timed out.',
            );
            clock.tick(101);
            await p;
            throw new Error('Wrong error.');
        } catch (err) {
            expect(err.message).toBe('Timed out.');
        } finally {
            clock.restore();
        }
    });

    test('should not timeout too soon', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const p = utils.addTimeoutToPromise(
                new Promise((r) => setTimeout(() => r('Done'), 100)),
                500,
                'Timed out.',
            );
            clock.tick(101);
            expect(await p).toBe('Done');
        } catch (err) {
            throw new Error('This should not fail.');
        } finally {
            clock.restore();
        }
    });
});

describe('utils.printOutdatedSdkWarning()', () => {
    let logMock;

    const currentVersion = require('../package.json').version; // eslint-disable-line

    beforeEach(() => {
        logMock = sinon.mock(log);
    });

    afterEach(() => {
        logMock.verify();
        logMock.restore();
    });

    test('should do nothing when ENV_VARS.SDK_LATEST_VERSION is not set', () => {
        delete process.env[ENV_VARS.SDK_LATEST_VERSION];
        logMock.expects('warning').never();
        utils.printOutdatedSdkWarning();
    });

    test('should do nothing when APIFY_DISABLE_OUTDATED_WARNING is set', () => {
        process.env.APIFY_DISABLE_OUTDATED_WARNING = '1';
        logMock.expects('warning').never();
        utils.printOutdatedSdkWarning();
        delete process.env.APIFY_DISABLE_OUTDATED_WARNING;
    });

    test('should correctly work when outdated', () => {
        process.env[ENV_VARS.SDK_LATEST_VERSION] = semver.inc(currentVersion, 'minor');
        logMock.expects('warning').once();
        utils.printOutdatedSdkWarning();
        delete process.env[ENV_VARS.SDK_LATEST_VERSION];
    });

    test('should correctly work when up to date', () => {
        process.env[ENV_VARS.SDK_LATEST_VERSION] = '0.13.0';
        logMock.expects('warning').never();
        utils.printOutdatedSdkWarning();
        delete process.env[ENV_VARS.SDK_LATEST_VERSION];
    });
});

describe('utils.parseContentTypeFromResponse', () => {
    test('should parse content type from header', () => {
        const parsed = utils.parseContentTypeFromResponse({ url: 'http://example.com', headers: { 'content-type': 'text/html; charset=utf-8' } });
        expect(parsed.type).toBe('text/html');
        expect(parsed.charset).toBe('utf-8');
    });

    test('should parse content type from file extension', () => {
        const parsedHtml = utils.parseContentTypeFromResponse({ url: 'http://www.example.com/foo/file.html?someparam=foo', headers: {} });
        expect(parsedHtml.type).toBe('text/html');
        expect(parsedHtml.charset).toBe('utf-8');

        const parsedTxt = utils.parseContentTypeFromResponse({ url: 'http://www.example.com/foo/file.txt', headers: {} });
        expect(parsedTxt.type).toBe('text/plain');
        expect(parsedTxt.charset).toBe('utf-8');
    });

    test('should return default content type for bad content type headers', () => {
        const parsedWithoutCt = utils.parseContentTypeFromResponse({ url: 'http://www.example.com/foo/file', headers: {} });
        expect(parsedWithoutCt.type).toBe('application/octet-stream');
        expect(parsedWithoutCt.charset).toBe('utf-8');

        const parsedBadHeader = utils.parseContentTypeFromResponse({
            url: 'http://www.example.com/foo/file.html',
            headers: { 'content-type': 'text/html,text/html' },
        });
        expect(parsedBadHeader.type).toBe('text/html');
        expect(parsedBadHeader.charset).toBe('utf-8');

        const parsedReallyBad = utils.parseContentTypeFromResponse({ url: 'http://www.example.com/foo', headers: { 'content-type': 'crazy-stuff' } });
        expect(parsedReallyBad.type).toBe('application/octet-stream');
        expect(parsedReallyBad.charset).toBe('utf-8');
    });
});

import * as _ from 'underscore';
import * as commandLineArgs from 'command-line-args';
import * as fs from 'fs';
import * as path from 'path';
import * as ShareDB from 'sharedb';
import * as ShareDBMongo from 'sharedb-mongo';
import * as express from 'express';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as WebSocketJSONStream from 'websocket-json-stream';
import * as Logger from 'js-logger';
import {ChatCodesChannelServer} from './cc_channel';


Logger.useDefaults();

export class ChatCodesServer {
	private db;
	private sharedb;
	private app = express();
	private server:http.Server;
	private wss:WebSocket.Server;
	private channels:Map<string, ChatCodesChannelServer> = new Map();
	private channelsDoc:Promise<ShareDB.Doc>;
	constructor(private shareDBPort:number, private shareDBURL:string=null) {
		/*
		Routes:
		chat.codes/{valid_channel_name} -> redirect to cc_web
		 */
		this.app.use('/channels', express.static(path.join(__dirname, '..', 'channel_pages')));
		this.app.use('/new', (req, res, next) => {
			const {lang, code, topic} = req.query;
			let channelName:string;
			this.createChannelName().then((ch:string) => {
				channelName = ch;
				return this.createNamespace(channelName, null, topic||null);
			}).then((ns) => {
				if(code) {
					return ns.addCodeFile(code||'', 'code', lang||'');
				} else {
					return false;
				}
			}).then(() => {
				res.redirect(`/${channelName}`);
			});
		});
		this.app.use([
			'/:channelName([a-zA-Z]+)/:convo([a-zA-Z0-9]+)',
			'/:channelName([a-zA-Z]+)'
		], (req, res, next) => {
			const channelName:string = req.params.channelName;
			const convo:string = req.params.convo;
			if(req.path === '/') {
				this.isValidChannelName(channelName).then((valid) => {
					if(valid) {
						next();
					} else {
						res.redirect('/new');
					}
				});
			} else {
				next();
			}
		}, express.static(path.join(__dirname, '..', 'cc_web')),
			express.static(path.join(__dirname, '..', 'cc_web', 'node_modules', 'ace-builds', 'src-min')));
		this.app.use('/', express.static(path.join(__dirname, '..', 'homepage')));


		this.server = http.createServer(this.app);
		this.wss = new WebSocket.Server( { server: this.server });
		this.setupShareDB();
	}
	private setupShareDB() {
		if(this.shareDBURL) {
			this.db = ShareDBMongo(this.shareDBURL);
		} else {
			this.db = new ShareDB.MemoryDB();
			// this.db = new ShareDBMingo();
		}
		this.sharedb = new ShareDB({ db: this.db });

		this.wss.on('connection', (ws, req) => {
			const stream = new WebSocketJSONStream(ws);
			this.sharedb.listen(stream);
			ws.on('message', (str:string) => {
				try {
					const data = JSON.parse(str);
					if(data.cc === 1) {
						const {type} = data;
						if(type === 'request-join-room') {
							const {payload, messageID} = data;
							const channel:string = payload['channel'];
							const channelID:string = payload['channelID'];
							let cs:ChatCodesChannelServer;
							if(channelID && this.channels.has(channel)  && this.channels.get(channel).getChannelID() === channelID) {
								cs = this.channels.get(channel);
								ws.send(JSON.stringify({
									channel,
									messageID,
									cc: 2,
									payload: {
										id: cs.getChannelID(),
										ns: cs.getShareDBNamespace()
									}
								}));
							} else {
								cs = this.createNamespace(channel, channelID);
								cs.addMember(payload, ws).then(() => {
									ws.send(JSON.stringify({
										channel,
										messageID,
										cc: 2,
										payload: {
											id: cs.getChannelID(),
											ns: cs.getShareDBNamespace()
										}
									}));
								});
							}
						} else if(type === 'channel-available') {
							const {payload, channel, messageID} = data;
							this.nobodyThere(channel).then((isEmpty) => {
								ws.send(JSON.stringify({
									channel,
									messageID,
									cc: 2,
									payload: isEmpty
								}));
							});
						}
					}
				} catch(e) {
					console.error(e);
				}
			});
		});

		this.channelsDoc = this.getShareDBChannels();

		this.server.listen(this.shareDBPort);
		Logger.info(`Created ShareDB server on port ${this.shareDBPort}`)
	}
	private createNamespace(channelName:string, channelID:string=null, topic:string=null):ChatCodesChannelServer {
		if(this.channels.has(channelName)) {
			const channelServer = this.channels.get(channelName);
			return channelServer;
		} else {
			let channelServer;
			if(channelID) { // is archived
				channelServer = new ChatCodesChannelServer(this.sharedb, this.wss, channelName, channelID, true);
			} else {
				channelServer = new ChatCodesChannelServer(this.sharedb, this.wss, channelName);
				this.channels.set(channelName, channelServer);
				Logger.debug(`Created channel ${channelServer.getChannelName()} (${channelServer.getChannelID()})`);

				this.pushChannel({
					channelName: channelName,
					channelID: channelServer.getChannelID(),
					created: (new Date()).getTime(),
					topic: topic,
					archived: false
					// ,data: false
				});
			}

			channelServer.on('self-destruct', (cs) => {
				this.destructNamespace(channelServer);
			});
			return channelServer;
		}
	}
	private pushChannel(li):Promise<ShareDB.Doc> {
		return this.channelsDoc.then((doc) => {
			const index = doc.data['channels'].length;
			const p = ['channels', doc.data['channels'].length];
			return this.submitChannelsOp({p, li});
		});
	}
	private submitOp(doc:ShareDB.Doc, data, options?):Promise<ShareDB.Doc> {
		return new Promise<ShareDB.Doc>((resolve, reject) => {
			doc.submitOp(data, options, (err) => {
				if(err) { reject(err); }
				else { resolve(doc); }
			})
		});
	}
	private submitChannelsOp(data, options?):Promise<ShareDB.Doc> {
		return this.channelsDoc.then((doc) => {
			return this.submitOp(doc, data, options);
		});
	}

	private getChannelIndex(channelID):Promise<number> {
		return this.channelsDoc.then((doc) => {
			const channels = doc.data['channels'];
			for(let i = 0; i<channels.length; i++) {
				if(channels[i].channelID === channelID) {
					return i;
				}
			}
			return -1;
		});
	}
	private destructNamespace(channelServer:ChatCodesChannelServer) {
		if(!channelServer.isArchive()) {
			const channelName = channelServer.getChannelName();
			this.channels.delete(channelName);
		}
		let index;
		let channelDoc;
		this.getChannelIndex(channelServer.getChannelID()).then((channelIndex) => {
			index = channelIndex;
			return this.channelsDoc;
		}).then((doc) => {
			channelDoc = doc;
			const od = channelDoc.data['channels'][index]['archived'];
			const oi = (new Date()).getTime();
			const p = ['channels', index, 'archived'];
			return this.submitChannelsOp({ p, oi, od });
		// }).then((doc) => {
		// 	return channelServer.stringify();
		// }).then((stringifiedChannel:string) => {
		// 	const od = channelDoc.data['channels'][index]['data'];
		// 	const oi = stringifiedChannel;
		// 	const p = ['channels', index, 'data'];
		// 	return this.submitChannelsOp({ p, oi, od });
		}).then((doc) => {
			return channelServer.destroy();
		}).then(() => {
			Logger.info(`Channel ${channelServer.getChannelName()} (${channelServer.getChannelID()}) was destroyed`);
		});
	}
	private nobodyThere(channelName:string):Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			if(this.channels.has(channelName)) {
				resolve(false);
			} else {
				resolve(true);
			}
		});
	};
	private getShareDBChannels():Promise<ShareDB.Doc> {
		return new Promise((resolve, reject) => {
			const connection = this.sharedb.connect();
			const doc = connection.get('chatcodes', 'channels');
			doc.fetch((err) => {
				if(err) {
					reject(err);
				} else if(doc.type === null) {
					doc.create({'channels': []}, 'json0', () => {
						Logger.debug(`Created channels doc`);
						resolve(doc);
					});
				} else {
					resolve(doc);
				}
			});
		});
	}
	private isValidChannelName(channelName:string):Promise<boolean> {
		const WORD_FILE_NAME:string = 'channel_names.txt'
		return readFile(path.join(__dirname, '..', WORD_FILE_NAME)).then((words:string) => {
			return words.indexOf(channelName)>=0 && channelName.indexOf('\n')<0;
		});
	}
	private createChannelName():Promise<string> {
		const WORD_FILE_NAME:string = 'channel_names.txt'
		return readFile(path.join(__dirname, '..', WORD_FILE_NAME)).then((words:string) => {
			// Put the list of opened words in a random order
			return _.shuffle(words.split(/\n/));
		}).then((wordList:Array<string>) => {
			function* getNextWord():Iterable<string> {
				for(let i = 0; i<wordList.length; i++) {
					yield wordList[i];
				}
				// If we couldn't find anything, start adding numbers to the end of words
				let j = 0;
				while(true) {
					yield wordList[j%wordList.length]+j+'';
					j++;
				}
			}
			const getNextAvailableName = (iterator) => {
				const {value} = iterator.next();
				return this.nobodyThere(value).then((available) => {
					return available ? value : getNextAvailableName(iterator);
				});
			}
            return getNextAvailableName(getNextWord());
		})
	}
}

const optionDefinitions = [
	{ name: 'memdb', alias: 'm', type: Boolean, defaultValue: false },
	{ name: 'mongocreds', alias: 'c', type: String, defaultValue: path.join(__dirname, '..', 'db_creds.json')},
	{ name: 'port', alias: 'p', type: Number, defaultValue: 8080 },
];
const options = commandLineArgs(optionDefinitions);

function readFile(filename:string):Promise<string> {
	return new Promise((resolve, reject) => {
		fs.readFile(filename, 'utf-8', (err, contents) => {
			if(err) { reject(err); }
			resolve(contents);
		});
	});
}
function getCredentials(filename):Promise<any> {
	return readFile(filename).then((contents:string) => {
		return JSON.parse(contents);
	});
}

if(options['memdb']) {
	const server = new ChatCodesServer(options.port);
} else {
	getCredentials(options['mongocreds']).then((info) => {
		const mongoDBURL:string = options['memdb'] ? null: info['url'];
		return new ChatCodesServer(options.port, mongoDBURL);
	});
}

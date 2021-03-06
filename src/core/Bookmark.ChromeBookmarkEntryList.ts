///<reference path="../app.ts" />
///<reference path="URL.ts" />
///<reference path="Bookmark.ts" />

interface BookmarkTreeNode {
  id: string;
  parentId: string;
  index: number;
  url: string;
  title: string;
  dateAdded: number;
  dateGroupModified: number;
  children: BookmarkTreeNode[];
}

module app.Bookmark {
  "use strict";

  export class ChromeBookmarkEntryList extends SyncableEntryList {
    rootNodeId: string;
    nodeIdStore: {[fixedURL:string]:string;} = {};
    ready = new app.Callbacks();
    needReconfigureRootNodeId = new app.Callbacks({persistent: true});

    private static entryToURL (entry:Entry):string {
      var url:string, param:any, hash:string;

      url = app.URL.fix(entry.url);

      param = {};

      if (typeof entry.resCount === "number" && !isNaN(entry.resCount)) {
        param.res_count = entry.resCount;
      }

      if (entry.readState) {
        param.last = entry.readState.last;
        param.read = entry.readState.read;
        param.received = entry.readState.received;
      }

      if (entry.expired === true) {
        param.expired = true;
      }

      hash = app.URL.buildQueryString(param);

      return url + (hash ? "#" + hash : "");
    }

    private static URLToEntry (url:string):Entry {
      var fixedURL:string, guessRes:app.URL.GuessResult, arg, entry:Entry;

      fixedURL = app.URL.fix(url);
      guessRes = app.URL.guessType(fixedURL);
      arg = app.URL.parseHashQuery(url);

      if (guessRes.type === "unknown") {
        return null;
      }

      entry = {
        type: guessRes.type,
        bbsType: guessRes.bbsType,
        url: fixedURL,
        title: fixedURL,
        resCount: null,
        readState: null,
        expired: false
      };

      if (/^\d+$/.test(arg.res_count)) {
        entry.resCount = +arg.res_count;
      }

      if (
        /^\d+$/.test(arg.received) &&
        /^\d+$/.test(arg.read) &&
        /^\d+$/.test(arg.last)
      ) {
        entry.readState = {
          url: fixedURL,
          received: +arg.received,
          read: +arg.read,
          last: + arg.last
        };
      }

      if (arg.expired === true) {
        entry.expired = true;
      }

      return entry;
    }

    constructor (rootNodeId:string) {
      super();

      this.setRootNodeId(rootNodeId);
      this.setUpChromeBookmarkWatcher();
    }

    private applyNodeAddToEntryList (node:BookmarkTreeNode):void {
      var entry:Entry;

      if (node.url && node.title) {
        entry = ChromeBookmarkEntryList.URLToEntry(node.url);
        if (entry === null) return;
        entry.title = node.title;

        // 既に同一URLのEntryが存在する場合、
        if (this.get(entry.url)) {
          // node側の方が新しいと判定された場合のみupdateを行う。
          if (app.Bookmark.newerEntry(entry, this.get(entry.url)) === entry) {
            delete this.nodeIdStore[entry.url];
            this.nodeIdStore[entry.url] = node.id;
            this.update(entry, false);
          }
          // addによりcreateChromeBookmarkが呼ばれた場合
          else if (!this.nodeIdStore[entry.url]) {
            this.nodeIdStore[entry.url] = node.id;
          }
        }
        else {
          this.nodeIdStore[entry.url] = node.id;
          this.add(entry, false);
        }
      }
    }

    private applyNodeUpdateToEntryList (nodeId:string, changes):void {
      var url:string, entry:Entry, newEntry:Entry;

      if (url = this.getURLFromNodeId(nodeId)) {
        entry = this.get(url);

        if (typeof changes.url === "string") {
          newEntry = ChromeBookmarkEntryList.URLToEntry(changes.url);
          newEntry.title = (
            typeof changes.title === "string" ? changes.title : entry.title
          );

          if (entry.url === newEntry.url) {
            if (
              (
                ChromeBookmarkEntryList.entryToURL(entry) !==
                ChromeBookmarkEntryList.entryToURL(newEntry)
              ) ||
              (entry.title !== newEntry.title)
            ) {
              this.update(newEntry, false);
            }
          }
          // ノードのURLが他の板/スレを示す物に変更された時
          else {
            delete this.nodeIdStore[url];
            this.nodeIdStore[newEntry.url] = nodeId;

            this.remove(entry.url, false);
            this.add(newEntry, false);
          }
        }
        else if (typeof changes.title === "string") {
          if (entry.title !== changes.title) {
            entry.title = changes.title;
            this.update(entry, false);
          }
        }
      }
    }

    private applyNodeRemoveToEntryList (nodeId:string):void {
      var url = this.getURLFromNodeId(nodeId);

      if (url !== null) {
        delete this.nodeIdStore[url];

        this.remove(url, false);
      }
    }

    private getURLFromNodeId (nodeId:string):string {
      var url:string;

      for (url in this.nodeIdStore) {
        if (this.nodeIdStore[url] === nodeId) {
          return url;
        }
      }

      return null;
    }

    private setUpChromeBookmarkWatcher ():void {
      var watching = true;

      chrome.bookmarks.onImportBegan.addListener(() => {
        watching = false;
      });

      chrome.bookmarks.onImportEnded.addListener(() => {
        watching = true;
        this.loadFromChromeBookmark();
      });

      chrome.bookmarks.onCreated.addListener((nodeId:string, node:BookmarkTreeNode) => {
        if (!watching) return;

        if (node.parentId === this.rootNodeId && typeof node.url === "string") {
          this.applyNodeAddToEntryList(node);
        }
      });

      chrome.bookmarks.onRemoved.addListener((nodeId:string) => {
        if (!watching) return;

        this.applyNodeRemoveToEntryList(nodeId);
      });

      chrome.bookmarks.onChanged.addListener((nodeId:string, changes) => {
        if (!watching) return;

        this.applyNodeUpdateToEntryList(nodeId, changes);
      });

      chrome.bookmarks.onMoved.addListener((nodeId:string, e) => {
        if (!watching) return;

        if (e.parentId === this.rootNodeId) {
          chrome.bookmarks.get(nodeId, (res:BookmarkTreeNode[]) => {
            if (res.length === 1 && typeof res[0].url === "string") {
              this.applyNodeAddToEntryList(res[0]);
            }
          });
        }
        else if (e.oldParentId === this.rootNodeId) {
          this.applyNodeRemoveToEntryList(nodeId);
        }
      });
    }

    setRootNodeId (rootNodeId:string, callback?:Function):void {
      this.rootNodeId = rootNodeId;
      this.loadFromChromeBookmark(callback);
    }

    private validateRootNodeSettings ():void {
      chrome.bookmarks.getChildren(this.rootNodeId, (res) => {
        if (!res) {
          this.needReconfigureRootNodeId.call();
        }
      });
    }

    private loadFromChromeBookmark (callback?:Function):void {
      // EntryListクリア
      this.getAll().forEach((entry:Entry) => {
        this.remove(entry.url, false);
      });

      // ロード
      chrome.bookmarks.getChildren(this.rootNodeId, (res:BookmarkTreeNode[]) => {
        if (res) {
          res.forEach((node) => {
            this.applyNodeAddToEntryList(node);
          });

          if (!this.ready.wasCalled) {
            this.ready.call();
          }

          if (callback) {
            callback(true);
          }
        }
        else {
          app.log("warn", "Chromeのブックマークからの読み込みに失敗しました。");
          this.validateRootNodeSettings();

          if (callback) {
            callback(false);
          }
        }
      });
    }

    private createChromeBookmark (entry:Entry, callback?:Function):void {
      chrome.bookmarks.create({
        parentId: this.rootNodeId,
        url: ChromeBookmarkEntryList.entryToURL(entry),
        title: entry.title
      }, (res:BookmarkTreeNode) => {
        if (!res) {
          app.log("error", "Chromeのブックマークへの追加に失敗しました");
          this.validateRootNodeSettings();
        }

        if (callback) {
          callback(!!res);
        }
      });
    }

    private updateChromeBookmark (newEntry:Entry, callback?:Function):void {
      var id:string;

      if (id = this.nodeIdStore[newEntry.url]) {
        chrome.bookmarks.get(id, (res:BookmarkTreeNode[]) => {
          var changes:any = {},
            node = res[0],
            newURL = ChromeBookmarkEntryList.entryToURL(newEntry),
            currentEntry = ChromeBookmarkEntryList.URLToEntry(node.url);

          if (node.title !== newEntry.title) {
            changes.title = newEntry.title;
          }

          if (node.url !== newURL) {
            changes.url = newURL;
          }

          if (Object.keys(changes).length === 0) {
            if (callback) {
              callback(true);
            }
          }
          else {
            chrome.bookmarks.update(
              id,
              changes,
              (res:BookmarkTreeNode) => {
                if (res) {
                  if (callback) {
                    callback(true);
                  }
                }
                else {
                  app.log("error", "Chromeのブックマーク更新に失敗しました");
                  this.validateRootNodeSettings();

                  if (callback) {
                    callback(false);
                  }
                }
              }
            );
          }
        });
      }
      else {
        if (callback) {
          callback(false);
        }
      }
    }

    private removeChromeBookmark (url:string, callback?:Function):void {
      var id:string;

      url = app.URL.fix(url);

      if (id = this.nodeIdStore[url]) {
        delete this.nodeIdStore[url];
        chrome.bookmarks.remove(id, function () {
          if (callback) {
            //TODO 失敗検出
            callback(true);
          }
        });
      }
      else {
        app.log("warn", "削除しようとしたブックマークの存在が確認できません。");
        if (callback) {
          callback(false);
        }
      }
    }

    add (entry:Entry, createChromeBookmark? = true, callback?:Function):bool {
      entry = app.deepCopy(entry);

      if (super.add(entry)) {
        if (createChromeBookmark) {
          if (callback) {
            this.createChromeBookmark(entry, callback);
          }
          else {
            this.createChromeBookmark(entry);
          }
        }
        else if (callback) {
          callback(true);
        }
        return true;
      }
      else {
        if (callback) {
          callback(false);
        }
        return false;
      }
    }

    update (entry:Entry, updateChromeBookmark? = true, callback?:Function):bool {
      entry = app.deepCopy(entry);

      if (super.update(entry)) {
        if (updateChromeBookmark) {
          if (callback) {
            this.updateChromeBookmark(entry, callback);
          }
          else {
            this.updateChromeBookmark(entry);
          }
        }
        else if (callback) {
          callback(true);
        }
        return true;
      }
      else {
        if (callback) {
          callback(false);
        }
        return false;
      }
    }

    remove (url:string, removeChromeBookmark? = true, callback?:Function):bool {
      if (super.remove(url)) {
        if (removeChromeBookmark) {
          if (callback) {
            this.removeChromeBookmark(url, callback);
          }
          else {
            this.removeChromeBookmark(url);
          }
        }
        else if (callback) {
          callback(true);
        }
        return true;
      }
      else if (callback) {
        callback(false);
        return false;
      }
    }
  }
}

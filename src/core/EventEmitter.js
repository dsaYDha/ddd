export class EventEmitter {
  constructor() {
    this._handlers = new Map();
  }
  on(type, fn) {
    let list = this._handlers.get(type);
    if (!list) { list = []; this._handlers.set(type, list); }
    list.push(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    const list = this._handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  emit(type, payload) {
    const list = this._handlers.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }
}

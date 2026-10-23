// Writing and signing books and quills. Follows mineflayer's book plugin (MIT): ≤1.12 plugin
// channels, 1.13–1.17 an edit_book carrying the item, 1.17.1+ an edit_book carrying the pages.
import type { PosseBot } from '../bot.js';
import type { Item } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-item and packets are loosely typed */

const EDIT_TIMEOUT = 20_000;

export interface BooksApi {
  writeBook(slot: number, pages: string[]): Promise<void>;
  signBook(slot: number, pages: string[], author: string, title: string): Promise<void>;
}

export function installBooks(bot: PosseBot): BooksApi {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const { Item } = bot.kit;
  const registry = bot.registry as any;
  let channels = false;

  const editBook = (book: Item, pages: string[], title: string | null, hotbarSlot: number, signing: boolean): void => {
    if (sf('editBookIsPluginChannel')) {
      if (!channels) {
        client.registerChannel('MC|BEdit', 'slot');
        client.registerChannel('MC|BSign', 'slot');
        channels = true;
      }
      client.writeChannel(signing ? 'MC|BSign' : 'MC|BEdit', Item.toNotch(book));
    } else if (sf('editBookPacketUsesNbt')) {
      client.write('edit_book', { new_book: Item.toNotch(book), signing, hand: 0 });
    } else {
      // 1.17.1+: the hotbar slot, the pages and (when signing) the title.
      client.write('edit_book', { hand: hotbarSlot, pages, title: signing ? title : undefined });
    }
  };

  const hasPages = (item: any): boolean => {
    if (item.componentMap) return item.componentMap.has('writable_book_content');
    return Boolean(item.nbt?.value?.pages);
  };

  /** The book as the game would have it after the edit (≤1.17 sends it whole). */
  const editedBook = (book: any, pages: string[], author: string | null, title: string | null, signing: boolean): Item => {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(book)), book);
    copy.nbt = book.nbt?.type === 'compound' ? { ...book.nbt, value: { ...book.nbt.value } } : { type: 'compound', name: '', value: {} };
    if (signing) {
      if (sf('clientUpdateBookIdWhenSign')) copy.type = registry.itemsByName.written_book.id;
      copy.nbt.value.author = { type: 'string', value: author };
      copy.nbt.value.title = { type: 'string', value: title };
    }
    copy.nbt.value.pages = { type: 'list', value: { type: 'string', value: pages } };
    return copy as Item;
  };

  const write = async (slot: number, pages: string[], author: string | null, title: string | null, signing: boolean): Promise<void> => {
    if (slot < 0 || slot > 44) throw new Error('slot out of inventory range');
    const book = bot.inventory.slots[slot];
    if (!book || book.type !== registry.itemsByName.writable_book.id) throw new Error(`no book found in slot ${slot}`);
    const quickBarSlot = bot.quickBarSlot;
    const moveToQuickBar = slot < 36;
    if (moveToQuickBar) {
      await bot.moveSlotItem(slot, 36);
      // 1.21.9+ never acknowledges an edit handled in the same tick as the clicks that put the book in hand.
      await bot.syncWindow(bot.inventory);
    }
    const hotbar = moveToQuickBar ? 0 : slot - 36;
    const bookSlot = 36 + hotbar;
    bot.setQuickBarSlot(hotbar);
    const modified = editedBook(bot.inventory.slots[bookSlot], pages, author, title, signing);
    (bot.inventory as any).updateSlot(bookSlot, modified);

    // Click echoes predate the edit, which the server applies later: only an update that reflects it counts.
    const writtenId = registry.itemsByName.written_book.id;
    const acked = new Promise<boolean>((resolve) => {
      const inv = bot.inventory as any;
      const timer = setTimeout(() => finish(false), EDIT_TIMEOUT);
      const onSlot = (_old: any, item: any): void => {
        if (item && (signing ? item.type === writtenId : hasPages(item))) finish(true);
      };
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        inv.removeListener(`updateSlot:${bookSlot}`, onSlot);
        resolve(ok);
      };
      inv.on(`updateSlot:${bookSlot}`, onSlot);
    });
    editBook(modified, pages, title, hotbar, signing);
    const ok = await acked;
    bot.setQuickBarSlot(quickBarSlot);
    if (moveToQuickBar) await bot.moveSlotItem(36, slot);
    if (!ok) throw new Error('The server did not confirm the book edit');
  };

  return {
    writeBook: (slot, pages) => write(slot, pages, null, null, false),
    signBook: (slot, pages, author, title) => write(slot, pages, author, title, true),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

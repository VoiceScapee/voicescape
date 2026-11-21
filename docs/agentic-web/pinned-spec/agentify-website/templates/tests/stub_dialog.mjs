import { StubElement } from "./stub_element.mjs";

/**
 * A stand-in for a <dialog> element, so tests can answer the confirmation dialog.
 *
 * StubDocument.createElement("dialog") returns one. As in a browser, close(value) sets
 * returnValue when a value is given, then fires "close". pressEscape() fires "cancel"
 * first, as a browser does, then closes the dialog with no value.
 */
export class StubDialog extends StubElement {
  /**
   * Create a closed dialog.
   */
  constructor() {
    super("dialog");
    this.open = false;
    this.returnValue = "";
    this.removed = false;
  }

  /**
   * Open the dialog.
   */
  showModal() {
    this.open = true;
  }

  /**
   * Close the dialog and fire "close".
   *
   * :param value: The return value, or undefined, as when the visitor presses Escape.
   */
  close(value) {
    if (value !== undefined) {
      this.returnValue = value;
    }
    this.open = false;
    this.dispatch("close");
  }

  /**
   * Press Escape: fire "cancel", then close the dialog with no value, unless a handler
   * prevented that or closed the dialog already.
   */
  pressEscape() {
    const event = {defaultPrevented: false};
    event.preventDefault = StubDialog.prevent.bind(null, event);
    this.dispatch("cancel", event);
    if (this.open && !event.defaultPrevented) {
      this.close();
    }
  }

  /**
   * Mark an event as prevented, as event.preventDefault() does.
   *
   * :param event: The event.
   */
  static prevent(event) {
    event.defaultPrevented = true;
  }

  /**
   * Record that page code removed the dialog.
   */
  remove() {
    this.removed = true;
  }
}

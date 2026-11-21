/**
 * A small stand-in for a DOM element, so page scripts can be imported under Node.
 *
 * It records text, values, attributes, children and event handlers. It is not a browser
 * emulator: add the methods your page script calls when a test fails on a missing one.
 *
 * It reads only ids and the hidden attribute from the HTML, so a select starts with
 * value "", not its selected option. Set starting values in the test setup, and fill
 * "elements" when page code reads form.elements or calls form.reset(). reset() restores
 * defaultValue and defaultChecked, so set those too when they are not empty.
 */
export class StubElement {
  /**
   * Create an element.
   *
   * :param tag: The tag name or selector this element stands for.
   */
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.required = false;
    this.validationMessage = "";
    this.elements = {};
    this.provided = new Map();
  }

  /**
   * Say what a selector other than a tag name matches inside this element. Use it for
   * matches that do not change during the test.
   *
   * :param selector: The exact selector the page code uses.
   * :param elements: The elements it finds, in page order.
   */
  provide(selector, elements) {
    this.provided.set(selector, elements);
  }

  /**
   * Append child nodes.
   *
   * :param nodes: The nodes to append.
   */
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
    }
  }

  /**
   * Append one child node.
   *
   * :param node: The node to append.
   * :return: The appended node.
   */
  appendChild(node) {
    this.children.push(node);
    return node;
  }

  /**
   * Insert child nodes at the start.
   *
   * :param nodes: The nodes to insert.
   */
  prepend(...nodes) {
    this.children.unshift(...nodes);
  }

  /**
   * Replace all children.
   *
   * :param nodes: The new children.
   */
  replaceChildren(...nodes) {
    this.children = nodes;
  }

  /**
   * Set an attribute.
   *
   * :param name: The attribute name.
   * :param value: The attribute value.
   */
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  /**
   * Read an attribute.
   *
   * :param name: The attribute name.
   * :return: The value, or null when it is not set.
   */
  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  /**
   * Remove an attribute.
   *
   * :param name: The attribute name.
   */
  removeAttribute(name) {
    delete this.attributes[name];
  }

  /**
   * Record an event handler so a test can trigger it with dispatch().
   *
   * :param name: The event name, such as "click" or "submit".
   * :param handler: The handler function.
   */
  addEventListener(name, handler) {
    if (!this.handlers[name]) {
      this.handlers[name] = [];
    }
    this.handlers[name].push(handler);
  }

  /**
   * Call every handler recorded for an event, as a user action would.
   *
   * :param name: The event name.
   * :param event: The event object to pass; preventDefault is added when missing.
   * :return: The number of handlers called.
   */
  dispatch(name, event = {}) {
    const handlers = this.handlers[name] || [];
    if (!event.preventDefault) {
      event.preventDefault = StubElement.ignore;
    }
    for (const handler of handlers) {
      handler(event);
    }
    return handlers.length;
  }

  /**
   * Do nothing. Used as a default preventDefault.
   */
  static ignore() {
  }

  /**
   * Record a custom validation message.
   *
   * :param message: The message, or "" when valid.
   */
  setCustomValidity(message) {
    this.validationMessage = message;
  }

  /**
   * Report whether this element and its recorded form elements are valid.
   *
   * :return: True when no element has a validation message or a missing required value.
   */
  reportValidity() {
    for (const element of Object.values(this.elements)) {
      if (element.validationMessage || (element.required && !element.value)) {
        return false;
      }
    }
    return !this.validationMessage;
  }

  /**
   * Find descendants whose tag matches.
   *
   * :param tag: The tag name to match, "<tag>:checked", or a selector given with provide().
   * :return: The matching descendants, depth first.
   * :raises Error: When the selector is none of these, so the stub cannot match it.
   */
  querySelectorAll(tag) {
    if (this.provided.has(tag)) {
      return [...this.provided.get(tag)];
    }
    // Pages often read ticked boxes with "input:checked", so match it from each box's state.
    const ticked = /^([a-z][a-z0-9-]*):checked$/i.exec(tag);
    if (ticked) {
      const found = [];
      for (const element of this.querySelectorAll(ticked[1])) {
        if (element.checked) {
          found.push(element);
        }
      }
      return found;
    }
    // An empty result for a selector the stub cannot match would let a test pass silently.
    if (!/^[a-z][a-z0-9-]*$/i.test(tag)) {
      throw new Error(`The stub matches tag names only, not "${tag}". Give the test its matches with element.provide(selector, elements), keep references to the elements, or test this in a browser.`);
    }
    const found = [];
    for (const child of this.children) {
      if (child instanceof StubElement) {
        if (child.tag === tag) {
          found.push(child);
        }
        found.push(...child.querySelectorAll(tag));
      }
    }
    return found;
  }

  /**
   * Find the first descendant whose tag matches.
   *
   * :param tag: The tag name to match, "<tag>:checked", or a selector given with provide().
   * :return: The first match, or null.
   * :raises Error: When the selector is none of these, so the stub cannot match it.
   */
  querySelector(tag) {
    const found = this.querySelectorAll(tag);
    return found.length ? found[0] : null;
  }

  /**
   * Report whether a node is this element or one of its descendants.
   *
   * :param node: The node to look for.
   * :return: True when the node is inside this element.
   */
  contains(node) {
    if (node === this) {
      return true;
    }
    for (const child of this.children) {
      if (child instanceof StubElement && child.contains(node)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Add a row to a table, as HTMLTableElement.insertRow does.
   *
   * :return: The new row.
   */
  insertRow() {
    const row = new StubElement("tr");
    this.children.push(row);
    return row;
  }

  /**
   * Add a cell to a table row, as HTMLTableRowElement.insertCell does.
   *
   * :return: The new cell.
   */
  insertCell() {
    const cell = new StubElement("td");
    this.children.push(cell);
    return cell;
  }

  /**
   * Accept focus calls from page code.
   */
  focus() {
    this.focused = true;
  }

  /**
   * Accept reset calls from page code by putting recorded form fields back on their
   * defaults, as a browser does.
   *
   * :raises Error: When no form elements are recorded, so the reset would clear nothing.
   */
  reset() {
    const elements = Object.values(this.elements);
    // A reset that clears nothing would let a test of a reset pass silently.
    if (elements.length === 0) {
      throw new Error(`The stub form ${this.tag} has no recorded elements, so reset() would clear nothing. Fill form.elements in the test setup.`);
    }
    for (const element of elements) {
      // A browser reset puts each box back on its defaultChecked and each other field
      // back on its defaultValue.
      if (element.type === "checkbox" || element.type === "radio") {
        element.checked = Boolean(element.defaultChecked);
      } else {
        element.value = element.defaultValue === undefined ? "" : element.defaultValue;
      }
    }
  }
}

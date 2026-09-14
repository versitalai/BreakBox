const makeFactory = (namespace) => new Proxy({}, {
    get: (_target, tag) => (attributes, ...children) => {
        const element = namespace
            ? document.createElementNS(namespace, tag)
            : document.createElement(tag);
        if (attributes != null && typeof attributes === "object" && !(attributes instanceof Node)) {
            for (const [name, value] of Object.entries(attributes)) {
                if (value == null) continue;
                if (name === "class") element.setAttribute("class", String(value));
                else if (name === "style" && typeof value === "string") element.setAttribute("style", value);
                else if (name.startsWith("on") && typeof value === "function") element.addEventListener(name.slice(2), value);
                else element.setAttribute(name, String(value));
            }
        } else if (attributes != null) {
            children.unshift(attributes);
        }
        for (const child of children.flat(Infinity)) {
            if (child == null) continue;
            element.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return element;
    },
});

module.exports = {
    HTML: makeFactory(null),
    SVG: makeFactory("http://www.w3.org/2000/svg"),
};

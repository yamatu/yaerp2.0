package service

import (
	"bytes"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	htmlparser "golang.org/x/net/html"
)

// mailInlineImageMaxSize bounds one inline image embedded into the body.
const mailInlineImageMaxSize = 8 << 20

// mailCIDReference matches cid: references in src/background attributes and
// CSS url(), e.g. `cid:image001.png@01DA1234.ABCD` (Outlook) or `CID:Part1`.
var mailCIDReference = regexp.MustCompile(`(?i)cid:([^"'\s)>]+)`)

// normalizeMailContentID makes a Content-ID header value and a cid: reference
// comparable: no angle brackets, URL-decoded, case-insensitive.
func normalizeMailContentID(value string) string {
	value = strings.Trim(strings.TrimSpace(value), "<>")
	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	return strings.ToLower(strings.Trim(value, "<>"))
}

// mailInlineImageType returns the image type of an inline part. Some clients
// send inline images as application/octet-stream; their bytes still tell.
func mailInlineImageType(contentType string, content []byte) string {
	if strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return contentType
	}
	if detected := http.DetectContentType(content); strings.HasPrefix(detected, "image/") && detected != "image/svg+xml" {
		return detected
	}
	return ""
}

// replaceMailCIDImages swaps cid: references for the images in inlineData
// (keyed by normalized Content-ID). Unknown references are left unchanged.
func replaceMailCIDImages(htmlValue string, inlineData map[string]string) string {
	if len(inlineData) == 0 || !strings.Contains(strings.ToLower(htmlValue), "cid:") {
		return htmlValue
	}
	return mailCIDReference.ReplaceAllStringFunc(htmlValue, func(match string) string {
		if dataURI, ok := inlineData[normalizeMailContentID(match[4:])]; ok {
			return dataURI
		}
		return match
	})
}

// referencedMailContentIDs lists the normalized Content-IDs an HTML body uses.
func referencedMailContentIDs(htmlValue string) map[string]bool {
	result := map[string]bool{}
	for _, match := range mailCIDReference.FindAllStringSubmatch(htmlValue, -1) {
		result[normalizeMailContentID(match[1])] = true
	}
	return result
}

type mailCSSRule struct {
	tag         string
	classes     []string
	specificity int
	order       int
	declaration string
}

var (
	mailCSSComment   = regexp.MustCompile(`(?s)/\*.*?\*/`)
	mailCSSSelector  = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[a-zA-Z_][\w-]*)*)$`)
	mailCSSImportant = regexp.MustCompile(`(?i)\s*!\s*important`)
)

const mailCSSMaxRules = 3000

// inlineMailStyleSheets copies the rules of <style> blocks onto the elements
// they match, as inline styles. The sanitizer removes <style> blocks, and mail
// pasted from Excel or Outlook keeps all table formatting (borders, fills,
// fonts) in class rules such as `.xl65{border:.5pt solid windowtext}`.
// Only simple selectors are applied: `td`, `.xl65`, `td.xl65`, comma lists.
// Rules inside at-rules (@media, @font-face) are skipped. Inline styles of the
// element still win, as in a browser.
func inlineMailStyleSheets(htmlValue string) string {
	if !strings.Contains(strings.ToLower(htmlValue), "<style") {
		return htmlValue
	}
	document, err := htmlparser.Parse(strings.NewReader(htmlValue))
	if err != nil {
		return htmlValue
	}
	var styleNodes []*htmlparser.Node
	var css strings.Builder
	var collect func(*htmlparser.Node)
	collect = func(node *htmlparser.Node) {
		if node.Type == htmlparser.ElementNode && strings.EqualFold(node.Data, "style") {
			styleNodes = append(styleNodes, node)
			for child := node.FirstChild; child != nil; child = child.NextSibling {
				css.WriteString(child.Data)
				css.WriteString("\n")
			}
			return
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			collect(child)
		}
	}
	collect(document)
	for _, node := range styleNodes {
		if node.Parent != nil {
			node.Parent.RemoveChild(node)
		}
	}
	rules := parseMailCSSRules(css.String())
	if len(rules) == 0 {
		return renderMailDocument(document, htmlValue)
	}

	var apply func(*htmlparser.Node)
	apply = func(node *htmlparser.Node) {
		if node.Type == htmlparser.ElementNode {
			applyMailCSSRules(node, rules)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			apply(child)
		}
	}
	apply(document)
	return renderMailDocument(document, htmlValue)
}

func renderMailDocument(document *htmlparser.Node, fallback string) string {
	var buffer bytes.Buffer
	if err := htmlparser.Render(&buffer, document); err != nil {
		return fallback
	}
	return buffer.String()
}

func parseMailCSSRules(css string) []mailCSSRule {
	css = mailCSSComment.ReplaceAllString(css, "")
	css = strings.NewReplacer("<!--", "", "-->", "").Replace(css)
	var rules []mailCSSRule
	order := 0
	for position := 0; position < len(css) && len(rules) < mailCSSMaxRules; {
		open := strings.IndexByte(css[position:], '{')
		if open < 0 {
			break
		}
		open += position
		selectorText := strings.TrimSpace(css[position:open])
		// Find the matching close brace; at-rules may nest blocks.
		depth, end := 0, -1
		for index := open; index < len(css); index++ {
			if css[index] == '{' {
				depth++
			} else if css[index] == '}' {
				depth--
				if depth == 0 {
					end = index
					break
				}
			}
		}
		if end < 0 {
			break
		}
		position = end + 1
		if strings.HasPrefix(selectorText, "@") {
			continue
		}
		declaration := strings.TrimSpace(mailCSSImportant.ReplaceAllString(css[open+1:end], ""))
		if declaration == "" || strings.ContainsAny(declaration, "{}") {
			continue
		}
		for _, selector := range strings.Split(selectorText, ",") {
			match := mailCSSSelector.FindStringSubmatch(strings.TrimSpace(selector))
			if match == nil || (match[1] == "" && match[2] == "") {
				continue
			}
			rule := mailCSSRule{tag: strings.ToLower(match[1]), order: order, declaration: declaration}
			if match[2] != "" {
				rule.classes = strings.Split(strings.ToLower(strings.TrimPrefix(match[2], ".")), ".")
			}
			rule.specificity = len(rule.classes) * 10
			if rule.tag != "" {
				rule.specificity++
			}
			rules = append(rules, rule)
			order++
		}
	}
	sort.SliceStable(rules, func(i, j int) bool {
		if rules[i].specificity != rules[j].specificity {
			return rules[i].specificity < rules[j].specificity
		}
		return rules[i].order < rules[j].order
	})
	return rules
}

func applyMailCSSRules(node *htmlparser.Node, rules []mailCSSRule) {
	classes := map[string]bool{}
	inline := ""
	styleIndex := -1
	for index, attribute := range node.Attr {
		switch strings.ToLower(attribute.Key) {
		case "class":
			for _, class := range strings.Fields(strings.ToLower(attribute.Val)) {
				classes[class] = true
			}
		case "style":
			inline = attribute.Val
			styleIndex = index
		}
	}
	tag := strings.ToLower(node.Data)
	var declarations []string
	for _, rule := range rules {
		if rule.tag != "" && rule.tag != tag {
			continue
		}
		matched := true
		for _, class := range rule.classes {
			if !classes[class] {
				matched = false
				break
			}
		}
		if matched {
			declarations = append(declarations, strings.TrimSuffix(rule.declaration, ";"))
		}
	}
	if len(declarations) == 0 {
		return
	}
	if strings.TrimSpace(inline) != "" {
		declarations = append(declarations, strings.TrimSuffix(strings.TrimSpace(inline), ";"))
	}
	style := strings.Join(declarations, ";")
	if styleIndex >= 0 {
		node.Attr[styleIndex].Val = style
		return
	}
	node.Attr = append(node.Attr, htmlparser.Attribute{Key: "style", Val: style})
}

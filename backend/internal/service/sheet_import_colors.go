package service

import (
	"strings"

	"github.com/xuri/excelize/v2"
)

// defaultExcelThemeColors is the Office theme, in the order Excel numbers
// theme colors (0 Background 1 ... 9 Accent 6). It is used when a file has
// no theme part, which many exporters omit.
var defaultExcelThemeColors = []string{
	"FFFFFF", "000000", "E7E6E6", "44546A",
	"4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47",
}

// resolveExcelColor turns a color reference of styles.xml (RGB, indexed
// palette entry or theme color with tint) into #RRGGBB, or "" when it
// names no concrete color (automatic, system colors). excelize returns ""
// for every fill color of a file without a theme part and never resolves
// theme font colors, so the importer resolves them itself.
func resolveExcelColor(file *excelize.File, auto bool, rgb string, indexed int, theme *int, tint float64) string {
	if auto {
		return ""
	}
	base := ""
	switch {
	case theme != nil:
		if file.Theme != nil {
			base = file.GetBaseColor("", 0, theme)
		}
		if normalizeExcelColor(base) == "" && *theme >= 0 && *theme < len(defaultExcelThemeColors) {
			base = defaultExcelThemeColors[*theme]
		}
	case strings.TrimSpace(rgb) != "":
		base = rgb
	case indexed > 0 && indexed < 64:
		base = file.GetBaseColor("", indexed, nil)
	}
	color := normalizeExcelColor(base)
	if color == "" {
		return ""
	}
	if tint != 0 {
		if tinted := normalizeExcelColor(excelize.ThemeColor(strings.TrimPrefix(color, "#"), tint)); tinted != "" {
			color = tinted
		}
	}
	return color
}

// rawExcelStyleColors reads the fill and font color of a cell style straight
// from styles.xml. GetStyle must have been called first (it loads the sheet).
func rawExcelStyleColors(file *excelize.File, styleID int) (fill, font string) {
	styles := file.Styles
	if styles == nil || styles.CellXfs == nil || styleID < 0 || styleID >= len(styles.CellXfs.Xf) {
		return "", ""
	}
	xf := styles.CellXfs.Xf[styleID]
	if xf.FillID != nil && styles.Fills != nil && *xf.FillID >= 0 && *xf.FillID < len(styles.Fills.Fill) {
		if entry := styles.Fills.Fill[*xf.FillID]; entry != nil && entry.PatternFill != nil {
			pattern := entry.PatternFill
			if pattern.PatternType != "" && pattern.PatternType != "none" {
				if pattern.FgColor != nil {
					fill = resolveExcelColor(file, pattern.FgColor.Auto, pattern.FgColor.RGB, pattern.FgColor.Indexed, pattern.FgColor.Theme, pattern.FgColor.Tint)
				}
				if fill == "" && pattern.BgColor != nil {
					fill = resolveExcelColor(file, pattern.BgColor.Auto, pattern.BgColor.RGB, pattern.BgColor.Indexed, pattern.BgColor.Theme, pattern.BgColor.Tint)
				}
			}
		}
	}
	if xf.FontID != nil && styles.Fonts != nil && *xf.FontID >= 0 && *xf.FontID < len(styles.Fonts.Font) {
		if entry := styles.Fonts.Font[*xf.FontID]; entry != nil && entry.Color != nil {
			font = resolveExcelColor(file, entry.Color.Auto, entry.Color.RGB, entry.Color.Indexed, entry.Color.Theme, entry.Color.Tint)
		}
	}
	return fill, font
}

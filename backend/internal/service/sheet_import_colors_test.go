package service

import (
	"archive/zip"
	"bytes"
	"io"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

// rewriteXLSX applies edit to every part of an xlsx package and drops the
// parts for which keep returns false.
func rewriteXLSX(t *testing.T, data []byte, edit func(name, body string) string, keep func(name string) bool) []byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, part := range reader.File {
		if keep != nil && !keep(part.Name) {
			continue
		}
		source, err := part.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(source)
		_ = source.Close()
		target, err := writer.Create(part.Name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = target.Write([]byte(edit(part.Name, string(body))))
	}
	_ = writer.Close()
	return out.Bytes()
}

// styledXLSX builds a sheet the way Excel saves common formatting: A1 an RGB
// fill, A2 a theme fill with a tint ("Accent 1, lighter 60%"), A3 white
// header text in the theme's "Background 1" color on a dark fill, A4 an
// indexed (legacy palette) fill.
var themeReference = regexp.MustCompile(`<(Relationship|Override)[^>]*theme1.xml"[^>]*?(/>|>s*</(Relationship|Override)>)`)

func styledXLSX(t *testing.T, withTheme bool) *excelize.File {
	t.Helper()
	file := excelize.NewFile()
	sheet := file.GetSheetName(0)
	colors := []string{"#FFFF00", "#ABCDEF", "#1F2937", "#00FF00"}
	fontColors := []string{"#123456", "#222222", "#654321", "#333333"}
	for index, color := range colors {
		style, err := file.NewStyle(&excelize.Style{Fill: excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{color}}, Font: &excelize.Font{Color: fontColors[index]}})
		if err != nil {
			t.Fatal(err)
		}
		axis, _ := excelize.CoordinatesToCellName(1, index+1)
		_ = file.SetCellValue(sheet, axis, "x")
		_ = file.SetCellStyle(sheet, axis, axis, style)
	}
	var buffer bytes.Buffer
	if err := file.Write(&buffer); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	data := rewriteXLSX(t, buffer.Bytes(), func(name, body string) string {
		switch {
		case name == "xl/styles.xml":
			body = strings.Replace(body, `<fgColor rgb="FFABCDEF"></fgColor>`, `<fgColor theme="4" tint="0.5999938962981048"></fgColor>`, 1)
			body = strings.Replace(body, `<fgColor rgb="FFABCDEF"/>`, `<fgColor theme="4" tint="0.5999938962981048"/>`, 1)
			body = strings.Replace(body, `<fgColor rgb="FF00FF00"></fgColor>`, `<fgColor indexed="10"></fgColor>`, 1)
			body = strings.Replace(body, `<fgColor rgb="FF00FF00"/>`, `<fgColor indexed="10"/>`, 1)
			// The font of A3 becomes theme color 0 (white text).
			if index := strings.Index(body, `<color rgb="FF654321"`); index >= 0 {
				end := strings.Index(body[index:], ">") + index + 1
				body = body[:index] + `<color theme="0"` + body[index+len(`<color rgb="FF654321"`):end] + body[end:]
			}
		case !withTheme && (name == "xl/_rels/workbook.xml.rels" || name == "[Content_Types].xml"):
			body = themeReference.ReplaceAllString(body, "")
		}
		return body
	}, func(name string) bool { return withTheme || name != "xl/theme/theme1.xml" })
	opened, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return opened
}

func importedFill(t *testing.T, snapshot *workbookImportSheetSnapshot, row int) string {
	t.Helper()
	cell := snapshot.Worksheet.CellData[strconv.Itoa(row)]["0"]
	ref, _ := cell.Style.(string)
	style := snapshot.Styles[ref]
	if style.Bg == nil || style.Bg.RGB == nil {
		return ""
	}
	return *style.Bg.RGB
}

func importedFontColor(t *testing.T, snapshot *workbookImportSheetSnapshot, row int) string {
	t.Helper()
	cell := snapshot.Worksheet.CellData[strconv.Itoa(row)]["0"]
	ref, _ := cell.Style.(string)
	style := snapshot.Styles[ref]
	if style.Cl == nil || style.Cl.RGB == nil {
		return ""
	}
	return *style.Cl.RGB
}

func TestImportKeepsFillAndFontColors(t *testing.T) {
	for _, withTheme := range []bool{true, false} {
		file := styledXLSX(t, withTheme)
		snapshot, err := buildWorkbookImportSheetSnapshot(file, file.GetSheetName(0), 0)
		_ = file.Close()
		if err != nil {
			t.Fatal(err)
		}
		label := map[bool]string{true: "with theme", false: "without theme part"}[withTheme]
		if got := importedFill(t, snapshot, 0); got != "#FFFF00" {
			t.Errorf("%s: RGB fill = %q, want #FFFF00", label, got)
		}
		if got := importedFill(t, snapshot, 1); got == "" {
			t.Errorf("%s: theme fill was dropped", label)
		}
		if got := importedFill(t, snapshot, 3); got != "#FF0000" && got != "#00FF00" {
			t.Errorf("%s: indexed fill = %q", label, got)
		}
		if got := importedFontColor(t, snapshot, 2); got != "#FFFFFF" {
			t.Errorf("%s: theme font color = %q, want #FFFFFF", label, got)
		}
		if got := importedFontColor(t, snapshot, 0); got != "#123456" {
			t.Errorf("%s: RGB font color = %q, want #123456", label, got)
		}
	}
}

package service

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type univerColorStyle struct {
	RGB *string `json:"rgb,omitempty"`
	TH  *int    `json:"th,omitempty"`
}

type univerTextDecoration struct {
	S  *int              `json:"s,omitempty"`
	C  *int              `json:"c,omitempty"`
	CL *univerColorStyle `json:"cl,omitempty"`
	T  *int              `json:"t,omitempty"`
}

type univerBorderStyleData struct {
	S  *int              `json:"s,omitempty"`
	CL *univerColorStyle `json:"cl,omitempty"`
}

type univerBorderData struct {
	T *univerBorderStyleData `json:"t,omitempty"`
	R *univerBorderStyleData `json:"r,omitempty"`
	B *univerBorderStyleData `json:"b,omitempty"`
	L *univerBorderStyleData `json:"l,omitempty"`
}

type univerTextRotation struct {
	A float64 `json:"a,omitempty"`
	V *int    `json:"v,omitempty"`
}

type univerPaddingData struct {
	T *float64 `json:"t,omitempty"`
	R *float64 `json:"r,omitempty"`
	B *float64 `json:"b,omitempty"`
	L *float64 `json:"l,omitempty"`
}

type univerNumberFormat struct {
	Pattern string `json:"pattern,omitempty"`
}

type univerStyleData struct {
	FF  *string               `json:"ff,omitempty"`
	FS  *float64              `json:"fs,omitempty"`
	It  *int                  `json:"it,omitempty"`
	Bl  *int                  `json:"bl,omitempty"`
	Ul  *univerTextDecoration `json:"ul,omitempty"`
	St  *univerTextDecoration `json:"st,omitempty"`
	Bg  *univerColorStyle     `json:"bg,omitempty"`
	Bd  *univerBorderData     `json:"bd,omitempty"`
	Cl  *univerColorStyle     `json:"cl,omitempty"`
	Ht  *int                  `json:"ht,omitempty"`
	Vt  *int                  `json:"vt,omitempty"`
	Tb  *int                  `json:"tb,omitempty"`
	Pd  *univerPaddingData    `json:"pd,omitempty"`
	Tr  *univerTextRotation   `json:"tr,omitempty"`
	N   *univerNumberFormat   `json:"n,omitempty"`
	Va  *int                  `json:"va,omitempty"`
	Ol  *univerTextDecoration `json:"ol,omitempty"`
	Bbl *univerTextDecoration `json:"bbl,omitempty"`
}

func extractUniverStyleMap(config json.RawMessage) (map[string]univerStyleData, error) {
	styles := make(map[string]univerStyleData)
	if len(config) == 0 {
		return styles, nil
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, fmt.Errorf("parse sheet config for styles: %w", err)
	}

	rawStyles, ok := payload["univerStyles"]
	if !ok || len(rawStyles) == 0 || string(rawStyles) == "null" {
		return styles, nil
	}

	if err := json.Unmarshal(rawStyles, &styles); err != nil {
		return nil, fmt.Errorf("parse univer styles: %w", err)
	}
	return styles, nil
}

func resolveUniverStyle(ref any, styles map[string]univerStyleData) *univerStyleData {
	switch typed := ref.(type) {
	case nil:
		return nil
	case string:
		style, ok := styles[typed]
		if !ok {
			return nil
		}
		cloned := cloneUniverStyle(&style)
		return &cloned
	case univerStyleData:
		cloned := cloneUniverStyle(&typed)
		return &cloned
	case *univerStyleData:
		if typed == nil {
			return nil
		}
		cloned := cloneUniverStyle(typed)
		return &cloned
	default:
		buffer, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		var style univerStyleData
		if err := json.Unmarshal(buffer, &style); err != nil {
			return nil
		}
		cloned := cloneUniverStyle(&style)
		return &cloned
	}
}

func composeUniverStyles(styles map[string]univerStyleData, refs ...any) *univerStyleData {
	var merged *univerStyleData
	for _, ref := range refs {
		resolved := resolveUniverStyle(ref, styles)
		merged = mergeUniverStyles(merged, resolved)
	}
	return merged
}

func mergeUniverStyles(base, overlay *univerStyleData) *univerStyleData {
	if base == nil && overlay == nil {
		return nil
	}
	if base == nil {
		cloned := cloneUniverStyle(overlay)
		return &cloned
	}
	merged := cloneUniverStyle(base)
	if overlay == nil {
		return &merged
	}

	if overlay.FF != nil {
		merged.FF = stringPtr(*overlay.FF)
	}
	if overlay.FS != nil {
		merged.FS = float64Ptr(*overlay.FS)
	}
	if overlay.It != nil {
		merged.It = intPtr(*overlay.It)
	}
	if overlay.Bl != nil {
		merged.Bl = intPtr(*overlay.Bl)
	}
	if overlay.Ul != nil {
		merged.Ul = cloneUniverTextDecoration(overlay.Ul)
	}
	if overlay.St != nil {
		merged.St = cloneUniverTextDecoration(overlay.St)
	}
	if overlay.Ol != nil {
		merged.Ol = cloneUniverTextDecoration(overlay.Ol)
	}
	if overlay.Bbl != nil {
		merged.Bbl = cloneUniverTextDecoration(overlay.Bbl)
	}
	if overlay.Bg != nil {
		merged.Bg = cloneUniverColorStyle(overlay.Bg)
	}
	if overlay.Cl != nil {
		merged.Cl = cloneUniverColorStyle(overlay.Cl)
	}
	if overlay.Bd != nil {
		merged.Bd = mergeUniverBorderData(merged.Bd, overlay.Bd)
	}
	if overlay.Ht != nil {
		merged.Ht = intPtr(*overlay.Ht)
	}
	if overlay.Vt != nil {
		merged.Vt = intPtr(*overlay.Vt)
	}
	if overlay.Tb != nil {
		merged.Tb = intPtr(*overlay.Tb)
	}
	if overlay.Pd != nil {
		merged.Pd = mergeUniverPaddingData(merged.Pd, overlay.Pd)
	}
	if overlay.Tr != nil {
		merged.Tr = cloneUniverTextRotation(overlay.Tr)
	}
	if overlay.N != nil {
		merged.N = &univerNumberFormat{Pattern: overlay.N.Pattern}
	}
	if overlay.Va != nil {
		merged.Va = intPtr(*overlay.Va)
	}
	return &merged
}

func cloneUniverStyle(style *univerStyleData) univerStyleData {
	if style == nil {
		return univerStyleData{}
	}
	cloned := *style
	cloned.FF = cloneStringPtr(style.FF)
	cloned.FS = cloneFloat64Ptr(style.FS)
	cloned.It = cloneIntPtr(style.It)
	cloned.Bl = cloneIntPtr(style.Bl)
	cloned.Va = cloneIntPtr(style.Va)
	cloned.Ul = cloneUniverTextDecoration(style.Ul)
	cloned.St = cloneUniverTextDecoration(style.St)
	cloned.Ol = cloneUniverTextDecoration(style.Ol)
	cloned.Bbl = cloneUniverTextDecoration(style.Bbl)
	cloned.Bg = cloneUniverColorStyle(style.Bg)
	cloned.Cl = cloneUniverColorStyle(style.Cl)
	cloned.Bd = cloneUniverBorderData(style.Bd)
	cloned.Ht = cloneIntPtr(style.Ht)
	cloned.Vt = cloneIntPtr(style.Vt)
	cloned.Tb = cloneIntPtr(style.Tb)
	cloned.Pd = cloneUniverPaddingData(style.Pd)
	cloned.Tr = cloneUniverTextRotation(style.Tr)
	if style.N != nil {
		cloned.N = &univerNumberFormat{Pattern: style.N.Pattern}
	}
	return cloned
}

func mergeUniverBorderData(base, overlay *univerBorderData) *univerBorderData {
	if base == nil && overlay == nil {
		return nil
	}
	if base == nil {
		return cloneUniverBorderData(overlay)
	}
	merged := cloneUniverBorderData(base)
	if overlay == nil {
		return merged
	}
	if overlay.T != nil {
		merged.T = cloneUniverBorderStyleData(overlay.T)
	}
	if overlay.R != nil {
		merged.R = cloneUniverBorderStyleData(overlay.R)
	}
	if overlay.B != nil {
		merged.B = cloneUniverBorderStyleData(overlay.B)
	}
	if overlay.L != nil {
		merged.L = cloneUniverBorderStyleData(overlay.L)
	}
	return merged
}

func mergeUniverPaddingData(base, overlay *univerPaddingData) *univerPaddingData {
	if base == nil && overlay == nil {
		return nil
	}
	if base == nil {
		return cloneUniverPaddingData(overlay)
	}
	merged := cloneUniverPaddingData(base)
	if overlay == nil {
		return merged
	}
	if overlay.T != nil {
		merged.T = float64Ptr(*overlay.T)
	}
	if overlay.R != nil {
		merged.R = float64Ptr(*overlay.R)
	}
	if overlay.B != nil {
		merged.B = float64Ptr(*overlay.B)
	}
	if overlay.L != nil {
		merged.L = float64Ptr(*overlay.L)
	}
	return merged
}

func cloneUniverBorderData(value *univerBorderData) *univerBorderData {
	if value == nil {
		return nil
	}
	return &univerBorderData{
		T: cloneUniverBorderStyleData(value.T),
		R: cloneUniverBorderStyleData(value.R),
		B: cloneUniverBorderStyleData(value.B),
		L: cloneUniverBorderStyleData(value.L),
	}
}

func cloneUniverBorderStyleData(value *univerBorderStyleData) *univerBorderStyleData {
	if value == nil {
		return nil
	}
	return &univerBorderStyleData{S: cloneIntPtr(value.S), CL: cloneUniverColorStyle(value.CL)}
}

func cloneUniverColorStyle(value *univerColorStyle) *univerColorStyle {
	if value == nil {
		return nil
	}
	return &univerColorStyle{RGB: cloneStringPtr(value.RGB), TH: cloneIntPtr(value.TH)}
}

func cloneUniverTextDecoration(value *univerTextDecoration) *univerTextDecoration {
	if value == nil {
		return nil
	}
	return &univerTextDecoration{S: cloneIntPtr(value.S), C: cloneIntPtr(value.C), CL: cloneUniverColorStyle(value.CL), T: cloneIntPtr(value.T)}
}

func cloneUniverPaddingData(value *univerPaddingData) *univerPaddingData {
	if value == nil {
		return nil
	}
	return &univerPaddingData{T: cloneFloat64Ptr(value.T), R: cloneFloat64Ptr(value.R), B: cloneFloat64Ptr(value.B), L: cloneFloat64Ptr(value.L)}
}

func cloneUniverTextRotation(value *univerTextRotation) *univerTextRotation {
	if value == nil {
		return nil
	}
	return &univerTextRotation{A: value.A, V: cloneIntPtr(value.V)}
}

func parseUniverColor(style *univerColorStyle) (int, int, int, bool) {
	if style == nil || style.RGB == nil {
		return 0, 0, 0, false
	}
	raw := strings.TrimSpace(*style.RGB)
	raw = strings.TrimPrefix(raw, "#")
	if len(raw) == 8 {
		raw = raw[:6]
	}
	if len(raw) != 6 {
		return 0, 0, 0, false
	}
	value, err := strconv.ParseUint(raw, 16, 32)
	if err != nil {
		return 0, 0, 0, false
	}
	return int(value >> 16), int((value >> 8) & 0xff), int(value & 0xff), true
}

func isMeaningfulUniverStyle(style *univerStyleData) bool {
	if style == nil {
		return false
	}
	return style.FF != nil || style.FS != nil || style.It != nil || style.Bl != nil || style.Ul != nil || style.St != nil || style.Ol != nil || style.Bbl != nil || style.Bg != nil || style.Bd != nil || style.Cl != nil || style.Ht != nil || style.Vt != nil || style.Tb != nil || style.Pd != nil || style.Tr != nil || style.N != nil || style.Va != nil
}

func cloneStringPtr(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneFloat64Ptr(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneIntPtr(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func stringPtr(value string) *string    { return &value }
func float64Ptr(value float64) *float64 { return &value }
func intPtr(value int) *int             { return &value }

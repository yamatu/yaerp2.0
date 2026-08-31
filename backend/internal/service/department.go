package service

import (
	"fmt"
	"strings"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type DepartmentService struct {
	departmentRepo *repo.DepartmentRepo
	userRepo       *repo.UserRepo
}

func NewDepartmentService(departmentRepo *repo.DepartmentRepo, userRepo *repo.UserRepo) *DepartmentService {
	return &DepartmentService{departmentRepo: departmentRepo, userRepo: userRepo}
}

func (s *DepartmentService) List() ([]model.Department, error) {
	return s.departmentRepo.List()
}

func (s *DepartmentService) Create(userID int64, req *model.CreateDepartmentRequest) (*model.Department, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return nil, fmt.Errorf("department name is required")
	}
	if err := s.validateMembers(req.MemberIDs); err != nil {
		return nil, err
	}
	department := &model.Department{
		Name: name, Description: strings.TrimSpace(req.Description), CreatedBy: &userID,
	}
	if err := s.departmentRepo.Create(department, req.MemberIDs); err != nil {
		return nil, err
	}
	return department, nil
}

func (s *DepartmentService) Update(id int64, req *model.UpdateDepartmentRequest) error {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return fmt.Errorf("department name is required")
	}
	return s.departmentRepo.Update(id, name, strings.TrimSpace(req.Description))
}

func (s *DepartmentService) Delete(id int64) error {
	return s.departmentRepo.Delete(id)
}

func (s *DepartmentService) SetMembers(id int64, userIDs []int64) error {
	if err := s.validateMembers(userIDs); err != nil {
		return err
	}
	return s.departmentRepo.SetMembers(id, userIDs)
}

func (s *DepartmentService) validateMembers(userIDs []int64) error {
	seen := make(map[int64]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if userID <= 0 {
			return fmt.Errorf("invalid user id %d", userID)
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		user, err := s.userRepo.GetByID(userID)
		if err != nil {
			return err
		}
		if user == nil || user.Status != 1 {
			return fmt.Errorf("user %d does not exist or is disabled", userID)
		}
	}
	return nil
}
